import { type PluginRegistry } from "./registry.js";
export declare function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string): void;
export declare function getActivePluginRegistry(): PluginRegistry | null;
export declare function requireActivePluginRegistry(): PluginRegistry;
export declare function getActivePluginRegistryKey(): string | null;
