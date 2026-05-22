import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
type ImplicitProviderParams = {
    agentDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    explicitProviders?: Record<string, ProviderConfig> | null;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
};
export declare function resolveProviderDiscoveryFilterForTest(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    resolveOwners?: (provider: string) => readonly string[] | undefined;
    providerIds?: readonly string[];
}): string[] | undefined;
export declare function resolvePluginMetadataProviderOwnersForTest(pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "owners"> | undefined, provider: string): readonly string[] | undefined;
export declare function resolveImplicitProviders(params: ImplicitProviderParams): Promise<NonNullable<OpenClawConfig["models"]>["providers"]>;
export {};
