import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
type BundledWebProviderPublicArtifactParams = {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
};
export declare function resolveBundledWebSearchProvidersFromPublicArtifacts(params: BundledWebProviderPublicArtifactParams): PluginWebSearchProviderEntry[] | null;
export declare function resolveBundledWebFetchProvidersFromPublicArtifacts(params: BundledWebProviderPublicArtifactParams): PluginWebFetchProviderEntry[] | null;
export {};
