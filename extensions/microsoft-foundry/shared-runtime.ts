export {
  TOKEN_REFRESH_MARGIN_MS,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  resolveConfiguredModelNameHint,
  type CachedTokenEntry,
} from "./shared.js";

export function getFoundryTokenCacheKey(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): string {
  return `${params?.subscriptionId ?? ""}:${params?.tenantId ?? ""}`;
}
