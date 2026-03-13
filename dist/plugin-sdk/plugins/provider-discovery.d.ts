import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";
export declare function resolvePluginDiscoveryProviders(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderPlugin[];
export declare function groupPluginDiscoveryProvidersByOrder(providers: ProviderPlugin[]): Record<ProviderDiscoveryOrder, ProviderPlugin[]>;
export declare function normalizePluginDiscoveryResult(params: {
    provider: ProviderPlugin;
    result: {
        provider: ModelProviderConfig;
    } | {
        providers: Record<string, ModelProviderConfig>;
    } | null | undefined;
}): Record<string, ModelProviderConfig>;
