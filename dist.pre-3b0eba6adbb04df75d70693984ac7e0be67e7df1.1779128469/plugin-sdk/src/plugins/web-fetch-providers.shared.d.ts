import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
export declare function sortWebFetchProviders(providers: PluginWebFetchProviderEntry[]): PluginWebFetchProviderEntry[];
export declare function sortWebFetchProvidersForAutoDetect(providers: PluginWebFetchProviderEntry[]): PluginWebFetchProviderEntry[];
export declare function resolveBundledWebFetchResolutionConfig(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
}): {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
};
