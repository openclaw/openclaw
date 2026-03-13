import { type PluginLoadOptions } from "./loader.js";
import type { ProviderPlugin } from "./types.js";
export declare function resolvePluginProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    /** Use an explicit env when plugin roots should resolve independently from process.env. */
    env?: PluginLoadOptions["env"];
}): ProviderPlugin[];
