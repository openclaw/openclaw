import type { PluginRegistry } from "./registry-types.js";
export declare function recordImportedPluginId(pluginId: string): void;
export declare function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string, runtimeSubagentMode?: "default" | "explicit" | "gateway-bindable", workspaceDir?: string): void;
export declare function getActivePluginRegistry(): PluginRegistry | null;
export declare function getActivePluginRegistryWorkspaceDir(): string | undefined;
export declare function requireActivePluginRegistry(): PluginRegistry;
export declare function pinActivePluginHttpRouteRegistry(registry: PluginRegistry): void;
export declare function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry): void;
export declare function getActivePluginHttpRouteRegistry(): PluginRegistry | null;
export declare function getActivePluginHttpRouteRegistryVersion(): number;
export declare function requireActivePluginHttpRouteRegistry(): PluginRegistry;
export declare function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry;
/** Pin the channel registry so that subsequent `setActivePluginRegistry` calls
 *  do not replace the channel snapshot used by `getChannelPlugin`. Call at
 *  gateway startup after the initial plugin load so that config-schema reads
 *  and other non-primary registry loads cannot evict channel plugins. */
export declare function pinActivePluginChannelRegistry(registry: PluginRegistry): void;
export declare function releasePinnedPluginChannelRegistry(registry?: PluginRegistry): void;
/** Return the registry that should be used for channel plugin resolution.
 *  When pinned, this returns the startup registry regardless of subsequent
 *  `setActivePluginRegistry` calls. */
export declare function getActivePluginChannelRegistry(): PluginRegistry | null;
export declare function getActivePluginChannelRegistryVersion(): number;
export declare function requireActivePluginChannelRegistry(): PluginRegistry;
export declare function getActivePluginRegistryKey(): string | null;
export declare function getActivePluginRuntimeSubagentMode(): "default" | "explicit" | "gateway-bindable";
export declare function getActivePluginRegistryVersion(): number;
/**
 * Returns plugin ids that were imported by plugin runtime or registry loading in
 * the current process.
 *
 * This is a process-level view, not a fresh import trace: cached registry reuse
 * still counts because the plugin code was loaded earlier in this process.
 * Explicit loader import tracking covers plugins that were imported but later
 * ended in an error state during registration.
 * Bundle-format plugins are excluded because they can be "loaded" from metadata
 * without importing any JS entrypoint.
 */
export declare function listImportedRuntimePluginIds(): string[];
export declare function resetPluginRuntimeStateForTest(): void;
