type PluginSdkAliasCandidateKind = "dist" | "src";
export type PluginSdkResolutionPreference = "auto" | "dist" | "src";
export type LoaderModuleResolveParams = {
    modulePath?: string;
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
};
export declare function normalizeJitiAliasTargetPath(targetPath: string): string;
export declare function resolveLoaderPackageRoot(params: LoaderModuleResolveParams & {
    modulePath: string;
}): string | null;
export declare function resolvePluginSdkAliasCandidateOrder(params: {
    modulePath: string;
    isProduction: boolean;
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginSdkAliasCandidateKind[];
export declare function listPluginSdkAliasCandidates(params: {
    srcFile: string;
    distFile: string;
    modulePath: string;
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): string[];
export declare function resolvePluginSdkAliasFile(params: {
    srcFile: string;
    distFile: string;
    modulePath?: string;
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): string | null;
export declare function listPluginSdkExportedSubpaths(params?: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): string[];
export declare function resolvePluginSdkScopedAliasMap(params?: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): Record<string, string>;
export declare function resolveExtensionApiAlias(params?: LoaderModuleResolveParams): string | null;
export declare function buildPluginLoaderAliasMap(modulePath: string, argv1?: string | undefined, moduleUrl?: string, pluginSdkResolution?: PluginSdkResolutionPreference): Record<string, string>;
export declare function resolvePluginRuntimeModulePath(params?: LoaderModuleResolveParams): string | null;
export declare function buildPluginLoaderJitiOptions(aliasMap: Record<string, string>): {
    interopDefault: boolean;
    tryNative: boolean;
    extensions: string[];
    alias?: Record<string, string> | undefined;
};
export declare function shouldPreferNativeModuleLoad(modulePath: string): boolean;
export declare function resolvePluginLoaderTryNative(modulePath: string, options?: {
    preferBuiltDist?: boolean;
}): boolean;
export declare function createPluginLoaderModuleCacheKey(params: {
    tryNative: boolean;
    aliasMap: Record<string, string>;
}): string;
export declare function resolvePluginLoaderModuleConfig(params: {
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
export declare function isBundledPluginExtensionPath(params: {
    modulePath: string;
    openClawPackageRoot: string;
    bundledPluginsDir?: string;
}): boolean;
export {};
