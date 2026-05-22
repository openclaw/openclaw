import { type PluginLoadOptions } from "./loader.js";
import type { ProviderPlugin } from "./types.js";
export declare function isPluginProvidersLoadInFlight(params: Parameters<typeof resolvePluginProviders>[0]): boolean;
export declare function resolvePluginProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    /** Use an explicit env when plugin roots should resolve independently from process.env. */
    env?: PluginLoadOptions["env"];
    bundledProviderAllowlistCompat?: boolean;
    bundledProviderVitestCompat?: boolean;
    onlyPluginIds?: string[];
    providerRefs?: readonly string[];
    modelRefs?: readonly string[];
    activate?: boolean;
    cache?: boolean;
    applyAutoEnable?: boolean;
    pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
    mode?: "runtime" | "setup";
    includeUntrustedWorkspacePlugins?: boolean;
}): ProviderPlugin[];
