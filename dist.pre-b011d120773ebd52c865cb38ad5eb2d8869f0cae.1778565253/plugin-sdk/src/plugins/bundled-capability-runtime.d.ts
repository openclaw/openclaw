import type { PluginLoadOptions } from "./loader.js";
import type { PluginRegistry } from "./registry.js";
import { type PluginSdkResolutionPreference } from "./sdk-alias.js";
export declare function buildVitestCapabilityShimAliasMap(): Record<string, string>;
export declare function buildBundledCapabilityRuntimeConfig(pluginIds: readonly string[], env?: PluginLoadOptions["env"]): PluginLoadOptions["config"];
export declare function loadBundledCapabilityRuntimeRegistry(params: {
    pluginIds: readonly string[];
    env?: PluginLoadOptions["env"];
    pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginRegistry;
