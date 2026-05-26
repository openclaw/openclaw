import type { PluginLoadOptions } from "./loader.js";
import { type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
export declare function resolvePluginWebSearchProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
    activate?: boolean;
    cache?: boolean;
    mode?: "runtime" | "setup";
    origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[];
export declare function resolveRuntimeWebSearchProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[];
