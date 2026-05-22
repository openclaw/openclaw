import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { type PluginRegistrySnapshot } from "./plugin-registry.js";
type ProviderManifestLoadParams = {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    registry?: PluginRegistrySnapshot;
    manifestRegistry?: PluginManifestRegistry;
};
type ProviderRegistryLoadParams = ProviderManifestLoadParams & {
    onlyPluginIds?: readonly string[];
};
export declare function withBundledProviderVitestCompat(params: {
    config: PluginLoadOptions["config"];
    pluginIds: readonly string[];
    env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"];
export declare function resolveBundledProviderCompatPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    manifestRegistry?: PluginManifestRegistry;
}): string[];
export declare function resolveEnabledProviderPluginIds(params: ProviderRegistryLoadParams): string[];
export declare function resolveExternalAuthProfileProviderPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
}): string[];
export declare function resolveExternalAuthProfileCompatFallbackPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    declaredPluginIds?: ReadonlySet<string>;
}): string[];
export declare function resolveDiscoveredProviderPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    registry?: PluginRegistrySnapshot;
    manifestRegistry?: PluginManifestRegistry;
    onlyPluginIds?: readonly string[];
    includeUntrustedWorkspacePlugins?: boolean;
}): string[];
export declare function resolveDiscoverableProviderOwnerPluginIds(params: {
    pluginIds: readonly string[];
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    includeUntrustedWorkspacePlugins?: boolean;
}): string[];
export declare function resolveActivatableProviderOwnerPluginIds(params: {
    pluginIds: readonly string[];
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    includeUntrustedWorkspacePlugins?: boolean;
}): string[];
export declare const __testing: {
    readonly resolveActivatableProviderOwnerPluginIds: typeof resolveActivatableProviderOwnerPluginIds;
    readonly resolveEnabledProviderPluginIds: typeof resolveEnabledProviderPluginIds;
    readonly resolveExternalAuthProfileCompatFallbackPluginIds: typeof resolveExternalAuthProfileCompatFallbackPluginIds;
    readonly resolveExternalAuthProfileProviderPluginIds: typeof resolveExternalAuthProfileProviderPluginIds;
    readonly resolveDiscoveredProviderPluginIds: typeof resolveDiscoveredProviderPluginIds;
    readonly resolveDiscoverableProviderOwnerPluginIds: typeof resolveDiscoverableProviderOwnerPluginIds;
    readonly resolveBundledProviderCompatPluginIds: typeof resolveBundledProviderCompatPluginIds;
    readonly withBundledProviderVitestCompat: typeof withBundledProviderVitestCompat;
};
export declare function resolveOwningPluginIdsForProvider(params: {
    provider: string;
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    manifestRegistry?: PluginManifestRegistry;
}): string[] | undefined;
export declare function resolveOwningPluginIdsForModelRef(params: {
    model: string;
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    manifestRegistry?: PluginManifestRegistry;
    registry?: PluginRegistrySnapshot;
}): string[] | undefined;
export declare function resolveOwningPluginIdsForModelRefs(params: {
    models: readonly string[];
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    manifestRegistry?: PluginManifestRegistry;
}): string[];
export declare function resolveNonBundledProviderPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
}): string[];
export declare function resolveCatalogHookProviderPluginIds(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
}): string[];
export {};
