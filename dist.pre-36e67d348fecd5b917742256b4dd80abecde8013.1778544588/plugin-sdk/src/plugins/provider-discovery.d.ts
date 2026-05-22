import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { type LoadPluginRegistryParams, type PluginRegistrySnapshot } from "./plugin-registry.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";
export type ResolveRuntimePluginDiscoveryProvidersParams = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: string[];
    includeUntrustedWorkspacePlugins?: boolean;
    requireCompleteDiscoveryEntryCoverage?: boolean;
    discoveryEntriesOnly?: boolean;
    pluginMetadataSnapshot?: PluginMetadataRegistryView;
};
export type ResolveInstalledPluginProviderContributionIdsParams = LoadPluginRegistryParams & {
    index?: PluginRegistrySnapshot;
    includeDisabled?: boolean;
};
export declare function resolveInstalledPluginProviderContributionIds(params?: ResolveInstalledPluginProviderContributionIdsParams): string[];
export declare function resolveRuntimePluginDiscoveryProviders(params: ResolveRuntimePluginDiscoveryProvidersParams): Promise<ProviderPlugin[]>;
export declare function groupPluginDiscoveryProvidersByOrder(providers: ProviderPlugin[]): Record<ProviderDiscoveryOrder, ProviderPlugin[]>;
export declare function normalizePluginDiscoveryResult(params: {
    provider: ProviderPlugin;
    result: {
        provider: ModelProviderConfig;
    } | {
        providers: Record<string, ModelProviderConfig>;
    } | null | undefined;
}): Record<string, ModelProviderConfig>;
export declare function runProviderCatalog(params: {
    provider: ProviderPlugin;
    config: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    resolveProviderApiKey: (providerId?: string) => {
        apiKey: string | undefined;
        discoveryApiKey?: string;
    };
    resolveProviderAuth: (providerId?: string, options?: {
        oauthMarker?: string;
    }) => {
        apiKey: string | undefined;
        discoveryApiKey?: string;
        mode: "api_key" | "oauth" | "token" | "none";
        source: "env" | "profile" | "none";
        profileId?: string;
    };
}): Promise<import("./types.js").ProviderCatalogResult> | undefined;
export declare function runProviderStaticCatalog(params: {
    provider: ProviderPlugin;
    config: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
}): Promise<import("./types.js").ProviderCatalogResult> | undefined;
