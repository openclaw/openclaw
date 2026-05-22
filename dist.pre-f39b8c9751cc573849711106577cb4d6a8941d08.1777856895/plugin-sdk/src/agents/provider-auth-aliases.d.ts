import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ProviderAuthAliasLookupParams = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
};
export declare function resetProviderAuthAliasMapCacheForTest(): void;
export declare function resolveProviderAuthAliasMap(params?: ProviderAuthAliasLookupParams): Record<string, string>;
export declare function resolveProviderIdForAuth(provider: string, params?: ProviderAuthAliasLookupParams): string;
