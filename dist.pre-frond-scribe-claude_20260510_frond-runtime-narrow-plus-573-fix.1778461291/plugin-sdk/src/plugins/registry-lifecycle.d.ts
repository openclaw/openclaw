import type { PluginRegistry } from "./registry-types.js";
export declare function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void;
export declare function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void;
export declare function isPluginRegistryRetired(registry: PluginRegistry): boolean;
