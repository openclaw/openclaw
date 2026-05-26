import { C as resolveConfiguredModelNameHint, _ as buildFoundryProviderBaseUrl, o as CachedTokenEntry, p as TOKEN_REFRESH_MARGIN_MS, v as extractFoundryEndpoint, y as isFoundryProviderApi } from "../../shared-FgR3yAtS.js";

//#region extensions/microsoft-foundry/shared-runtime.d.ts
declare function getFoundryTokenCacheKey(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): string;
//#endregion
export { type CachedTokenEntry, TOKEN_REFRESH_MARGIN_MS, buildFoundryProviderBaseUrl, extractFoundryEndpoint, getFoundryTokenCacheKey, isFoundryProviderApi, resolveConfiguredModelNameHint };