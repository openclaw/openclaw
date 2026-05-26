import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";

//#region src/agents/provider-auth-aliases.d.ts
type ProviderAuthAliasLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};
declare function resetProviderAuthAliasMapCacheForTest(): void;
declare function resolveProviderAuthAliasMap(params?: ProviderAuthAliasLookupParams): Record<string, string>;
declare function resolveProviderIdForAuth(provider: string, params?: ProviderAuthAliasLookupParams): string;
//#endregion
export { resolveProviderIdForAuth as i, resetProviderAuthAliasMapCacheForTest as n, resolveProviderAuthAliasMap as r, ProviderAuthAliasLookupParams as t };