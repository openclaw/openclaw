import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { type ProviderConfig } from "./models-config.providers.js";
export type ResolveImplicitProvidersForModelsJson = (params: {
    agentDir: string;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    explicitProviders: Record<string, ProviderConfig>;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
}) => Promise<Record<string, ProviderConfig>>;
export type ModelsJsonPlan = {
    action: "skip";
} | {
    action: "noop";
} | {
    action: "write";
    contents: string;
};
export declare function resolveProvidersForModelsJsonWithDeps(params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
}, deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
}): Promise<Record<string, ProviderConfig>>;
export declare function planOpenClawModelsJsonWithDeps(params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    existingRaw: string;
    existingParsed: unknown;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
}, deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
}): Promise<ModelsJsonPlan>;
export declare function planOpenClawModelsJson(params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0]): Promise<ModelsJsonPlan>;
