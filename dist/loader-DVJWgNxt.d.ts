import { i as OpenClawConfig, p as PluginInstallRecord } from "./types.openclaw-BLF4DJTX.js";
import { a as PluginDiscoveryResult, n as PluginManifestRegistry } from "./manifest-registry-CMekBFSM.js";
import { A as OpenClawPluginDefinition, C as OpenClawPluginApi, ht as PluginLogger } from "./types-Vx7Jq4_-2.js";
import { n as GatewayRequestHandler } from "./types-BMFYBAxt.js";
import { t as CreatePluginRuntimeOptions } from "./types-DpjQFFwi.js";
import { t as PluginActivationConfigSource } from "./config-state-BGq9BY_v.js";
import { t as NormalizedPluginsConfig } from "./config-normalization-shared-5-arMumO.js";
import { a as PluginRegistryParams, i as PluginRegistry } from "./registry-types-F3hmOVKr.js";
import { _ as resolvePluginSdkScopedAliasMap, c as listPluginSdkExportedSubpaths, g as resolvePluginSdkAliasFile, h as resolvePluginSdkAliasCandidateOrder, i as buildPluginLoaderJitiOptions, m as resolvePluginRuntimeModulePath, n as PluginSdkResolutionPreference, r as buildPluginLoaderAliasMap, s as listPluginSdkAliasCandidates, u as resolveExtensionApiAlias, v as shouldPreferNativeModuleLoad } from "./sdk-alias-DYD-tX1X.js";

//#region src/shared/import-specifier.d.ts
/**
 * On Windows, Node's ESM loader requires absolute paths to be expressed as
 * file:// URLs. Raw drive-letter paths like C:\... are parsed as URL schemes.
 */
declare function toSafeImportPath(specifier: string): string;
//#endregion
//#region src/plugins/loader-channel-setup.d.ts
declare function shouldLoadChannelPluginInSetupRuntime(params: {
  manifestChannels: string[];
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean;
//#endregion
//#region src/plugins/plugin-sdk-dist-alias.d.ts
declare function ensureOpenClawPluginSdkAlias(distRoot: string): void;
//#endregion
//#region src/plugins/loader-cache-state.d.ts
declare class PluginLoadReentryError extends Error {
  readonly cacheKey: string;
  constructor(cacheKey: string);
}
//#endregion
//#region src/plugins/loader.d.ts
type PluginLoadResult = PluginRegistry;
type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  runtimeOptions?: CreatePluginRuntimeOptions;
  startupTrace?: {
    detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  };
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  /**
   * Prefer `setupEntry` for configured channel plugins that explicitly opt in
   * via package metadata because their setup entry covers the pre-listen startup surface.
   */
  preferSetupRuntimeForChannelPlugins?: boolean;
  /**
   * For hot startup paths, prefer bundled plugin JS artifacts over source TS
   * entrypoints when both are present in a source checkout.
   */
  preferBuiltPluginArtifacts?: boolean;
  toolDiscovery?: boolean;
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
};
declare class PluginLoadFailureError extends Error {
  readonly pluginIds: string[];
  readonly registry: PluginRegistry;
  constructor(registry: PluginRegistry);
}
declare function clearPluginLoaderCache(): void;
declare function clearActivatedPluginRuntimeState(): void;
declare function clearPluginRegistryLoadCache(): void;
declare function createGuardedPluginRegistrationApi(api: OpenClawPluginApi): {
  api: OpenClawPluginApi;
  close: () => void;
};
declare function runPluginRegisterSync(register: NonNullable<OpenClawPluginDefinition["register"]>, api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0]): void;
declare const testing: {
  buildPluginLoaderJitiOptions: typeof buildPluginLoaderJitiOptions;
  buildPluginLoaderAliasMap: typeof buildPluginLoaderAliasMap;
  listPluginSdkAliasCandidates: typeof listPluginSdkAliasCandidates;
  listPluginSdkExportedSubpaths: typeof listPluginSdkExportedSubpaths;
  resolveExtensionApiAlias: typeof resolveExtensionApiAlias;
  resolvePluginSdkScopedAliasMap: typeof resolvePluginSdkScopedAliasMap;
  resolvePluginSdkAliasCandidateOrder: typeof resolvePluginSdkAliasCandidateOrder;
  resolvePluginSdkAliasFile: typeof resolvePluginSdkAliasFile;
  resolvePluginRuntimeModulePath: typeof resolvePluginRuntimeModulePath;
  ensureOpenClawPluginSdkAlias: typeof ensureOpenClawPluginSdkAlias;
  shouldLoadChannelPluginInSetupRuntime: typeof shouldLoadChannelPluginInSetupRuntime;
  shouldPreferNativeModuleLoad: typeof shouldPreferNativeModuleLoad;
  toSafeImportPath: typeof toSafeImportPath;
  createGuardedPluginRegistrationApi: typeof createGuardedPluginRegistrationApi;
  runPluginRegisterSync: typeof runPluginRegisterSync;
  getCompatibleActivePluginRegistry: typeof getCompatibleActivePluginRegistry;
  resolvePluginLoadCacheContext: typeof resolvePluginLoadCacheContext;
  readonly maxPluginRegistryCacheEntries: number;
  setMaxPluginRegistryCacheEntriesForTest(value?: number): void;
};
declare function resolvePluginLoadCacheContext(options?: PluginLoadOptions): {
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSourceConfig: OpenClawConfig;
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  onlyPluginIds: string[] | undefined;
  includeSetupOnlyChannelPlugins: boolean;
  forceSetupOnlyChannelPlugins: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins: boolean;
  preferSetupRuntimeForChannelPlugins: boolean;
  preferBuiltPluginArtifacts: boolean;
  shouldActivate: boolean;
  shouldLoadModules: boolean;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  installRecords: {
    [x: string]: PluginInstallRecord;
  };
  cacheKey: string;
};
declare function getCompatibleActivePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
declare function resolveRuntimePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
declare function getRuntimePluginRegistryForLoadOptions(options?: PluginLoadOptions): PluginRegistry | undefined;
declare function resolvePluginRegistryLoadCacheKey(options?: PluginLoadOptions): string;
declare function isPluginRegistryLoadInFlight(options?: PluginLoadOptions): boolean;
declare function resolveCompatibleRuntimePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined;
declare function loadOpenClawPlugins(options?: PluginLoadOptions): PluginRegistry;
declare function loadOpenClawPluginCliRegistry(options?: PluginLoadOptions): Promise<PluginRegistry>;
//#endregion
export { clearPluginLoaderCache as a, isPluginRegistryLoadInFlight as c, resolveCompatibleRuntimePluginRegistry as d, resolvePluginRegistryLoadCacheKey as f, PluginLoadReentryError as h, clearActivatedPluginRuntimeState as i, loadOpenClawPluginCliRegistry as l, testing as m, PluginLoadOptions as n, clearPluginRegistryLoadCache as o, resolveRuntimePluginRegistry as p, PluginLoadResult as r, getRuntimePluginRegistryForLoadOptions as s, PluginLoadFailureError as t, loadOpenClawPlugins as u };