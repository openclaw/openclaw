import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry.js";
export type ResolvePluginWebProvidersParams = {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
    activate?: boolean;
    cache?: boolean;
    mode?: "runtime" | "setup";
    origin?: PluginManifestRecord["origin"];
};
type ResolveWebProviderRuntimeDeps<TEntry> = {
    resolveBundledResolutionConfig: (params: {
        config?: PluginLoadOptions["config"];
        workspaceDir?: string;
        env?: PluginLoadOptions["env"];
        bundledAllowlistCompat?: boolean;
    }) => {
        config: PluginLoadOptions["config"];
        activationSourceConfig?: PluginLoadOptions["config"];
        autoEnabledReasons: Record<string, string[]>;
    };
    resolveCandidatePluginIds: (params: {
        config?: PluginLoadOptions["config"];
        workspaceDir?: string;
        env?: PluginLoadOptions["env"];
        onlyPluginIds?: readonly string[];
        origin?: PluginManifestRecord["origin"];
    }) => string[] | undefined;
    mapRegistryProviders: (params: {
        registry: PluginRegistry;
        onlyPluginIds?: readonly string[];
    }) => TEntry[];
    resolveBundledPublicArtifactProviders?: (params: {
        config?: PluginLoadOptions["config"];
        workspaceDir?: string;
        env?: PluginLoadOptions["env"];
        bundledAllowlistCompat?: boolean;
        onlyPluginIds?: readonly string[];
    }) => TEntry[] | null;
};
export declare function resolvePluginWebProviders<TEntry>(params: ResolvePluginWebProvidersParams, deps: ResolveWebProviderRuntimeDeps<TEntry>): TEntry[];
export declare function resolveRuntimeWebProviders<TEntry>(params: Omit<ResolvePluginWebProvidersParams, "activate" | "cache" | "mode">, deps: ResolveWebProviderRuntimeDeps<TEntry>): TEntry[];
export {};
