import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/agents/tools/web-search-provider-config.d.ts
declare function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown;
declare function setTopLevelCredentialValue(searchConfigTarget: Record<string, unknown>, value: unknown): void;
declare function getScopedCredentialValue(searchConfig: Record<string, unknown> | undefined, key: string): unknown;
declare function setScopedCredentialValue(searchConfigTarget: Record<string, unknown>, key: string, value: unknown): void;
declare function mergeScopedSearchConfig(searchConfig: Record<string, unknown> | undefined, key: string, pluginConfig: Record<string, unknown> | undefined, options?: {
  mirrorApiKeyToTopLevel?: boolean;
}): Record<string, unknown> | undefined;
declare function resolveProviderWebSearchPluginConfig(config: OpenClawConfig | undefined, pluginId: string): Record<string, unknown> | undefined;
declare function setProviderWebSearchPluginConfigValue(configTarget: OpenClawConfig, pluginId: string, key: string, value: unknown): void;
//#endregion
export { setProviderWebSearchPluginConfigValue as a, resolveProviderWebSearchPluginConfig as i, getTopLevelCredentialValue as n, setScopedCredentialValue as o, mergeScopedSearchConfig as r, setTopLevelCredentialValue as s, getScopedCredentialValue as t };