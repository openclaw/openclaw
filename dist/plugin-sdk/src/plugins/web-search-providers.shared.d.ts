import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
export declare function sortWebSearchProviders(providers: PluginWebSearchProviderEntry[]): PluginWebSearchProviderEntry[];
export declare function sortWebSearchProvidersForAutoDetect(providers: PluginWebSearchProviderEntry[]): PluginWebSearchProviderEntry[];
export declare function resolveBundledWebSearchResolutionConfig(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
}): {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
};
