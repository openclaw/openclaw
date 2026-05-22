import type { OpenClawPackageManifest } from "./manifest.js";
type BundledChannelEntryPathPair = {
    source: string;
    built: string;
};
export type BundledChannelPluginMetadata = {
    dirName: string;
    source: BundledChannelEntryPathPair;
    setupSource?: BundledChannelEntryPathPair;
    manifest: {
        id: string;
        channels?: readonly string[];
    };
    packageManifest?: OpenClawPackageManifest;
    rootDir: string;
};
export declare function listBundledChannelPluginMetadata(params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
}): readonly BundledChannelPluginMetadata[];
export declare function resolveBundledChannelGeneratedPath(rootDir: string, entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"], pluginDirName?: string, scanDir?: string): string | null;
export declare function resolveBundledChannelWorkspacePath(params: {
    rootDir: string;
    scanDir?: string;
    pluginId: string;
}): string | null;
export {};
