import { type PluginLoadOptions } from "./loader.js";
import type { ProviderPlugin } from "./types.js";
export declare function resolvePluginProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
}): ProviderPlugin[];
