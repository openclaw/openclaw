import { type OpenClawPackageManifest, type PluginManifest } from "./manifest.js";
type BundledPluginPathPair = {
    source: string;
    built: string;
};
export type BundledPluginMetadata = {
    dirName: string;
    idHint: string;
    source: BundledPluginPathPair;
    setupSource?: BundledPluginPathPair;
    publicSurfaceArtifacts?: readonly string[];
    runtimeSidecarArtifacts?: readonly string[];
    packageName?: string;
    packageVersion?: string;
    packageDescription?: string;
    packageManifest?: OpenClawPackageManifest;
    manifest: PluginManifest;
};
export declare function listBundledPluginMetadata(params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[];
export declare function findBundledPluginMetadataById(pluginId: string, params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
}): BundledPluginMetadata | undefined;
export declare function resolveBundledPluginWorkspaceSourcePath(params: {
    rootDir: string;
    scanDir?: string;
    pluginId: string;
}): string | null;
export declare function resolveBundledPluginGeneratedPath(rootDir: string, entry: BundledPluginPathPair | undefined, pluginDirName?: string, scanDir?: string): string | null;
export declare function resolveBundledPluginRepoEntryPath(params: {
    rootDir: string;
    pluginId: string;
    preferBuilt?: boolean;
    scanDir?: string;
}): string | null;
export {};
