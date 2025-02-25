import * as _ from "lodash";
import { from, Observable } from "rxjs";
import { map } from "rxjs/operators";
import { v4 as uuidv4 } from "uuid";

import { ADDON_PROVIDER_HUB, IPC_WOWUP_GET_SCAN_RESULTS } from "../../common/constants";
import { Addon } from "../../common/entities/addon";
import { WowClientType } from "../../common/warcraft/wow-client-type";
import { AddonChannelType, WowUpScanResult } from "../../common/wowup/models";
import { AppConfig } from "../../environments/environment";
import { SourceRemovedAddonError } from "../errors";
import { WowUpAddonReleaseRepresentation, WowUpAddonRepresentation } from "../models/wowup-api/addon-representations";
import {
  WowUpGetAddonReleaseResponse,
  WowUpGetAddonResponse,
  WowUpGetAddonsResponse,
  WowUpSearchAddonsResponse,
} from "../models/wowup-api/api-responses";
import { GetAddonsByFingerprintResponse } from "../models/wowup-api/get-addons-by-fingerprint.response";
import { WowGameType } from "../models/wowup-api/wow-game-type";
import { AddonFolder } from "../models/wowup/addon-folder";
import { AddonSearchResult } from "../models/wowup/addon-search-result";
import { AddonSearchResultFile } from "../models/wowup/addon-search-result-file";
import { AppWowUpScanResult } from "../models/wowup/app-wowup-scan-result";
import { WowInstallation } from "../models/wowup/wow-installation";
import { ElectronService } from "../services";
import { CachingService } from "../services/caching/caching-service";
import { CircuitBreakerWrapper, NetworkService } from "../services/network/network.service";
import { getGameVersion } from "../utils/addon.utils";
import { getEnumName } from "../utils/enum.utils";
import { AddonProvider, GetAllResult } from "./addon-provider";

const API_URL = AppConfig.wowUpHubUrl;
const CHANGELOG_CACHE_TTL_SEC = 30 * 60;

export interface GetAddonBatchResponse {
  addons: WowUpAddonRepresentation[];
}

export class WowUpAddonProvider extends AddonProvider {
  private readonly _circuitBreaker: CircuitBreakerWrapper;

  public readonly name = ADDON_PROVIDER_HUB;
  public readonly forceIgnore = false;
  public readonly allowReinstall = true;
  public readonly allowChannelChange = true;
  public readonly allowEdit = true;
  public enabled = true;

  public constructor(
    private _electronService: ElectronService,
    private _cachingService: CachingService,
    _networkService: NetworkService
  ) {
    super();

    this._circuitBreaker = _networkService.getCircuitBreaker(
      `${this.name}_main`,
      AppConfig.defaultHttpResetTimeoutMs,
      AppConfig.wowUpHubHttpTimeoutMs
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getDescription(installation: WowInstallation, externalId: string, addon?: Addon): Promise<string> {
    try {
      const response = await this.getAddonById(externalId);
      return response.addon?.description;
    } catch (e) {
      console.error("Failed to get description", e);
    }
    return "";
  }

  public shouldMigrate(addon: Addon): boolean {
    return !addon.installedExternalReleaseId;
  }

  public async getAll(installation: WowInstallation, addonIds: string[]): Promise<GetAllResult> {
    const gameType = this.getWowGameType(installation.clientType);
    const url = new URL(`${API_URL}/addons/batch/${gameType}`);
    const addonIdList = _.map(addonIds, (id) => parseInt(id, 10));

    const response = await this._circuitBreaker.postJson<GetAddonBatchResponse>(url, {
      addonIds: addonIdList,
    });

    const searchResults = _.map(response?.addons, (addon) => this.getSearchResult(addon, gameType));

    const missingAddonIds = _.filter(
      addonIds,
      (addonId) => _.find(searchResults, (sr) => sr.externalId === addonId) === undefined
    );

    const deletedErrors = _.map(missingAddonIds, (addonId) => new SourceRemovedAddonError(addonId, undefined));

    return {
      errors: [...deletedErrors],
      searchResults,
    };
  }

  public async getFeaturedAddons(installation: WowInstallation): Promise<AddonSearchResult[]> {
    const gameType = this.getWowGameType(installation.clientType);
    const url = new URL(`${API_URL}/addons/featured/${gameType}?count=60`);

    const addons = await this._cachingService.transaction(
      url.toString(),
      () => this._circuitBreaker.getJson<WowUpGetAddonsResponse>(url),
      CHANGELOG_CACHE_TTL_SEC
    );

    const searchResults = _.map(addons?.addons, (addon) => this.getSearchResult(addon, gameType));
    return searchResults;
  }

  public async searchByQuery(query: string, installation: WowInstallation): Promise<AddonSearchResult[]> {
    const gameType = this.getWowGameType(installation.clientType);
    const url = new URL(`${API_URL}/addons/search/${gameType}?query=${query}&limit=10`);

    const addons = await this._cachingService.transaction(
      url.toString(),
      () => this._circuitBreaker.getJson<WowUpSearchAddonsResponse>(url),
      5
    );
    const searchResults = _.map(addons?.addons, (addon) => this.getSearchResult(addon, gameType));

    return searchResults;
  }

  public isValidAddonUri(): boolean {
    // TODO
    return false;
  }

  public isValidAddonId(addonId: string): boolean {
    const idNumber = parseInt(addonId, 10);
    return !isNaN(idNumber) && isFinite(idNumber) && idNumber > 0;
  }

  public getById(addonId: string, installation: WowInstallation): Observable<AddonSearchResult> {
    const gameType = this.getWowGameType(installation.clientType);
    const url = new URL(`${API_URL}/addons/${addonId}`);
    const task = this._cachingService.transaction(
      url.toString(),
      () => this._circuitBreaker.getJson<WowUpGetAddonResponse>(url),
      CHANGELOG_CACHE_TTL_SEC
    );

    return from(task).pipe(
      map((result) => {
        return this.getSearchResult(result.addon, gameType);
      })
    );
  }

  public async getReleaseById(addonId: string, releaseId: string): Promise<WowUpGetAddonReleaseResponse> {
    const url = new URL(`${API_URL}/addons/${addonId}/releases/${releaseId}`);
    return await this._cachingService.transaction(
      url.toString(),
      async () => this._circuitBreaker.getJson<WowUpGetAddonReleaseResponse>(url),
      CHANGELOG_CACHE_TTL_SEC
    );
  }

  public async scan(
    installation: WowInstallation,
    addonChannelType: AddonChannelType,
    addonFolders: AddonFolder[]
  ): Promise<void> {
    const gameType = this.getWowGameType(installation.clientType);

    console.time("WowUpScan");
    const scanResults = await this.getScanResults(addonFolders);
    console.timeEnd("WowUpScan");

    const fingerprints = scanResults.map((result) => result.fingerprint);
    console.log("[WowUpFingerprints]", JSON.stringify(fingerprints));
    const fingerprintResponse = await this.getAddonsByFingerprints(fingerprints);

    for (const scanResult of scanResults) {
      const fingerprintMatches = fingerprintResponse.exactMatches.filter((exactMatch) =>
        this.hasMatchingFingerprint(scanResult, exactMatch.matched_release)
      );

      let clientMatch = fingerprintMatches.find((exactMatch) => this.hasGameType(exactMatch.matched_release, gameType));

      if (!clientMatch && fingerprintMatches.length > 0) {
        console.warn(`No matching client type found for ${scanResult.folderName}, using fallback`);
        clientMatch = fingerprintMatches[0];
      }

      scanResult.exactMatch = clientMatch;
    }

    for (const addonFolder of addonFolders) {
      const scanResult = scanResults.find((sr) => sr.path === addonFolder.path);
      if (!scanResult.exactMatch) {
        continue;
      }

      try {
        const newAddon = this.getAddon(installation, addonChannelType, scanResult);

        addonFolder.matchingAddon = newAddon;
      } catch (err) {
        console.error(scanResult);
        console.error(err);
      }
    }
  }

  public async getChangelog(
    installation: WowInstallation,
    externalId: string,
    externalReleaseId: string
  ): Promise<string> {
    console.debug("getChangelog");
    try {
      const addon = await this.getReleaseById(externalId, externalReleaseId);
      return addon?.release?.body ?? "";
    } catch (e) {
      console.error("Failed to get changelog", e);
    }

    return "";
  }

  public getScanResults = async (addonFolders: AddonFolder[]): Promise<AppWowUpScanResult[]> => {
    const filePaths = addonFolders.map((addonFolder) => addonFolder.path);

    const scanResults: AppWowUpScanResult[] = await this._electronService.invoke(IPC_WOWUP_GET_SCAN_RESULTS, filePaths);

    return scanResults;
  };

  private async getAddonById(addonId: number | string) {
    const url = new URL(`${API_URL}/addons/${addonId}`);
    return await this._cachingService.transaction(
      url.toString(),
      () => this._circuitBreaker.getJson<WowUpGetAddonResponse>(url),
      CHANGELOG_CACHE_TTL_SEC
    );
  }

  private hasMatchingFingerprint(scanResult: WowUpScanResult, release: WowUpAddonReleaseRepresentation) {
    return release.addonFolders.some((addonFolder) => addonFolder.fingerprint == scanResult.fingerprint);
  }

  private hasGameType(release: WowUpAddonReleaseRepresentation, clientType: WowGameType): boolean {
    const matchingVersion = this.getMatchingVersion(release, clientType);
    return matchingVersion !== undefined;
  }

  private getAddonsByFingerprints(fingerprints: string[]): Promise<GetAddonsByFingerprintResponse> {
    const url = `${API_URL}/addons/fingerprint`;

    return this._circuitBreaker.postJson<any>(url, {
      fingerprints,
    });
  }

  private getAddonReleaseChannel(file: WowUpAddonReleaseRepresentation) {
    return file.prerelease ? AddonChannelType.Beta : AddonChannelType.Stable;
  }

  // Only 1 game version should match a given game type
  private getMatchingVersion(release: WowUpAddonReleaseRepresentation, gameType: WowGameType) {
    return release.game_versions.find((gv) => gv.game_type === gameType);
  }

  private getSearchResultFile(release: WowUpAddonReleaseRepresentation, gameType: WowGameType): AddonSearchResultFile {
    const matchingVersion = this.getMatchingVersion(release, gameType);
    const version = matchingVersion?.version ?? release.tag_name;

    return {
      channelType: this.getAddonReleaseChannel(release),
      downloadUrl: release.download_url,
      folders: [],
      gameVersion: getGameVersion(matchingVersion?.interface),
      releaseDate: release.published_at,
      version: version,
      dependencies: [],
      changelog: release.body,
      externalId: release.id.toString(),
      title: matchingVersion?.title,
      authors: matchingVersion?.authors,
    };
  }

  private filterReleases(representation: WowUpAddonRepresentation, gameType: WowGameType) {
    return _.filter(representation.releases, (release) =>
      release.game_versions.some((gv) => gv.game_type === gameType)
    );
  }

  private getSearchResult(representation: WowUpAddonRepresentation, gameType: WowGameType): AddonSearchResult {
    const clientReleases = this.filterReleases(representation, gameType);
    const searchResultFiles: AddonSearchResultFile[] = _.map(clientReleases, (release) =>
      this.getSearchResultFile(release, gameType)
    );

    const name = _.first(searchResultFiles)?.title ?? representation.repository_name;
    const authors = _.first(searchResultFiles)?.authors ?? representation.owner_name;

    return {
      author: authors,
      externalId: representation.id.toString(),
      externalUrl: representation.repository,
      name,
      providerName: this.name,
      thumbnailUrl: representation.image_url || representation.owner_image_url,
      downloadCount: representation.total_download_count,
      files: searchResultFiles,
      releasedAt: new Date(),
      screenshotUrl: "",
      screenshotUrls: [],
      summary: representation.description,
      fundingLinks: [...representation.funding_links],
    };
  }

  private getAddon(
    installation: WowInstallation,
    addonChannelType: AddonChannelType,
    scanResult: AppWowUpScanResult
  ): Addon {
    const gameType = this.getWowGameType(installation.clientType);
    const folders = scanResult.exactMatch.matched_release.addonFolders.map((af) => af.folder_name);
    const folderList = folders.join(", ");
    const channelType = addonChannelType;

    let matchingVersion = this.getMatchingVersion(scanResult.exactMatch.matched_release, gameType);
    if (!matchingVersion) {
      matchingVersion = scanResult?.exactMatch?.matched_release?.game_versions[0];
      console.warn(
        `No matching version found: ${scanResult.exactMatch.repository_name}, using fallback ${matchingVersion.interface}`
      );
    }

    const name = matchingVersion?.title ?? scanResult.exactMatch.repository_name;
    const version = matchingVersion?.version ?? scanResult.exactMatch.matched_release.tag_name;
    const authors = matchingVersion?.authors ?? scanResult.exactMatch.owner_name;
    const interfaceVer = matchingVersion?.interface;

    return {
      id: uuidv4(),
      author: authors,
      name,
      channelType,
      autoUpdateEnabled: false,
      clientType: installation.clientType,
      downloadUrl: scanResult.exactMatch.matched_release.download_url,
      externalUrl: scanResult.exactMatch.repository,
      externalId: scanResult.exactMatch.id.toString(),
      gameVersion: getGameVersion(interfaceVer),
      installedAt: new Date(),
      installedFolders: folderList,
      installedFolderList: folders,
      installedVersion: version,
      installedExternalReleaseId: scanResult.exactMatch.matched_release.id.toString(),
      isIgnored: false,
      latestVersion: version,
      providerName: this.name,
      providerSource: scanResult.exactMatch.source,
      thumbnailUrl: scanResult.exactMatch.image_url,
      fundingLinks: [...scanResult.exactMatch.funding_links],
      isLoadOnDemand: false,
      releasedAt: scanResult.exactMatch?.matched_release?.published_at,
      externalChannel: getEnumName(AddonChannelType, channelType),
      latestChangelog: scanResult.exactMatch?.matched_release?.body,
      externalLatestReleaseId: scanResult?.exactMatch?.matched_release?.id?.toString(),
      installationId: installation.id,
    };
  }

  private getWowGameType(clientType: WowClientType): WowGameType {
    switch (clientType) {
      case WowClientType.ClassicEra:
        return WowGameType.Classic;
      case WowClientType.Classic:
      case WowClientType.ClassicPtr:
      case WowClientType.ClassicBeta:
        return WowGameType.BurningCrusade;
      case WowClientType.Retail:
      case WowClientType.RetailPtr:
      case WowClientType.Beta:
      default:
        return WowGameType.Retail;
    }
  }
}
