import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry, WebSearchProviderToolDefinition } from "../plugins/types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import type { ResolveWebSearchDefinitionParams, RunWebSearchParams, RunWebSearchResult, RuntimeWebSearchConfig as WebSearchConfig } from "./runtime-types.js";
export type { ListWebSearchProvidersParams, ResolveWebSearchDefinitionParams, RunWebSearchParams, RunWebSearchResult, RuntimeWebSearchConfig, RuntimeWebSearchProviderEntry, RuntimeWebSearchToolDefinition, } from "./runtime-types.js";
declare function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig;
export declare function resolveWebSearchEnabled(params: {
    search?: WebSearchConfig;
    sandboxed?: boolean;
}): boolean;
export declare function isWebSearchProviderConfigured(params: {
    provider: Pick<PluginWebSearchProviderEntry, "credentialPath" | "id" | "envVars" | "getConfiguredCredentialValue" | "getConfiguredCredentialFallback" | "getCredentialValue" | "requiresCredential">;
    config?: OpenClawConfig;
}): boolean;
export declare function listWebSearchProviders(params?: {
    config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[];
export declare function listConfiguredWebSearchProviders(params?: {
    config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[];
export declare function resolveWebSearchProviderId(params: {
    search?: WebSearchConfig;
    config?: OpenClawConfig;
    providers?: PluginWebSearchProviderEntry[];
}): string;
declare function resolveExplicitWebSearchProviderId(params: {
    search?: WebSearchConfig;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
    providerId?: string;
    includeRuntimeSelection?: boolean;
}): string | undefined;
declare function resolveExplicitWebSearchProviderPluginIds(params: {
    config?: OpenClawConfig;
    search?: WebSearchConfig;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
    providerId?: string;
    includeRuntimeSelection?: boolean;
}): readonly string[] | undefined;
export declare function resolveWebSearchDefinition(options?: ResolveWebSearchDefinitionParams): {
    provider: PluginWebSearchProviderEntry;
    definition: WebSearchProviderToolDefinition;
} | null;
declare function resolveWebSearchCandidates(options?: ResolveWebSearchDefinitionParams): PluginWebSearchProviderEntry[];
declare function hasExplicitWebSearchSelection(params: {
    search?: WebSearchConfig;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
    providerId?: string;
    providers?: PluginWebSearchProviderEntry[];
}): boolean;
export declare function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult>;
export declare const __testing: {
    resolveSearchConfig: typeof resolveSearchConfig;
    resolveSearchProvider: typeof resolveWebSearchProviderId;
    resolveWebSearchProviderId: typeof resolveWebSearchProviderId;
    resolveWebSearchCandidates: typeof resolveWebSearchCandidates;
    resolveExplicitWebSearchProviderId: typeof resolveExplicitWebSearchProviderId;
    resolveExplicitWebSearchProviderPluginIds: typeof resolveExplicitWebSearchProviderPluginIds;
    hasExplicitWebSearchSelection: typeof hasExplicitWebSearchSelection;
};
