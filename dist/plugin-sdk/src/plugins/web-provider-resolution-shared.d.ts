import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
export type WebProviderContract = "webSearchProviders" | "webFetchProviders";
export type WebProviderConfigKey = "webSearch" | "webFetch";
export type WebProviderCandidateResolution = {
    pluginIds: string[] | undefined;
    manifestRecords?: readonly PluginManifestRecord[];
};
type WebProviderSortEntry = {
    id: string;
    pluginId: string;
    autoDetectOrder?: number;
};
export declare function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(providers: T[]): T[];
export declare function sortPluginProvidersForAutoDetect<T extends WebProviderSortEntry>(providers: T[]): T[];
export declare function resolveManifestDeclaredWebProviderCandidatePluginIds(params: {
    contract: WebProviderContract;
    configKey: WebProviderConfigKey;
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
}): string[] | undefined;
export declare function resolveManifestDeclaredWebProviderCandidates(params: {
    contract: WebProviderContract;
    configKey: WebProviderConfigKey;
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
    manifestRecords?: readonly PluginManifestRecord[];
}): WebProviderCandidateResolution;
export declare function resolveBundledWebProviderResolutionConfig(params: {
    contract: WebProviderContract;
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
}): {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
};
export declare function mapRegistryProviders<TProvider extends {
    id: string;
}>(params: {
    entries: readonly {
        pluginId: string;
        provider: TProvider;
    }[];
    onlyPluginIds?: readonly string[];
    sortProviders: (providers: Array<TProvider & {
        pluginId: string;
    }>) => Array<TProvider & {
        pluginId: string;
    }>;
}): Array<TProvider & {
    pluginId: string;
}>;
export {};
