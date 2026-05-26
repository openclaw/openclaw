//#region src/plugins/sdk-alias.d.ts
type PluginSdkAliasCandidateKind = "dist" | "src";
type PluginSdkResolutionPreference = "auto" | "dist" | "src";
type LoaderModuleResolveParams = {
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};
declare function normalizeJitiAliasTargetPath(targetPath: string): string;
declare function resolveLoaderPackageRoot(params: LoaderModuleResolveParams & {
  modulePath: string;
}): string | null;
declare function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginSdkAliasCandidateKind[];
declare function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string[];
declare function resolvePluginSdkAliasFile(params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string | null;
declare function listPluginSdkExportedSubpaths(params?: {
  modulePath?: string;
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string[];
declare function resolvePluginSdkScopedAliasMap(params?: {
  modulePath?: string;
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): Record<string, string>;
declare function resolveExtensionApiAlias(params?: LoaderModuleResolveParams): string | null;
declare function buildPluginLoaderAliasMap(modulePath: string, argv1?: string | undefined, moduleUrl?: string, pluginSdkResolution?: PluginSdkResolutionPreference): Record<string, string>;
declare function resolvePluginRuntimeModulePath(params?: LoaderModuleResolveParams): string | null;
declare function buildPluginLoaderJitiOptions(aliasMap: Record<string, string>): {
  alias?: Record<string, string> | undefined;
  interopDefault: boolean;
  tryNative: boolean;
  extensions: string[];
};
declare function shouldPreferNativeModuleLoad(modulePath: string): boolean;
declare function resolvePluginLoaderTryNative(modulePath: string, options?: {
  preferBuiltDist?: boolean;
}): boolean;
declare function createPluginLoaderModuleCacheKey(params: {
  tryNative: boolean;
  aliasMap: Record<string, string>;
}): string;
declare function resolvePluginLoaderModuleConfig(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl: string;
  preferBuiltDist?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): {
  tryNative: boolean;
  aliasMap: Record<string, string>;
  cacheKey: string;
};
declare function isBundledPluginExtensionPath(params: {
  modulePath: string;
  openClawPackageRoot: string;
  bundledPluginsDir?: string;
}): boolean;
//#endregion
export { resolvePluginSdkScopedAliasMap as _, createPluginLoaderModuleCacheKey as a, listPluginSdkExportedSubpaths as c, resolveLoaderPackageRoot as d, resolvePluginLoaderModuleConfig as f, resolvePluginSdkAliasFile as g, resolvePluginSdkAliasCandidateOrder as h, buildPluginLoaderJitiOptions as i, normalizeJitiAliasTargetPath as l, resolvePluginRuntimeModulePath as m, PluginSdkResolutionPreference as n, isBundledPluginExtensionPath as o, resolvePluginLoaderTryNative as p, buildPluginLoaderAliasMap as r, listPluginSdkAliasCandidates as s, LoaderModuleResolveParams as t, resolveExtensionApiAlias as u, shouldPreferNativeModuleLoad as v };