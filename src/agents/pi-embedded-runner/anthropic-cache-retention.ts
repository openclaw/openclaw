import { resolveAnthropicCacheRetentionFamily } from "./anthropic-family-cache-semantics.js";

type CacheRetention = "none" | "short" | "long";

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelApi?: string,
  modelId?: string,
): CacheRetention | undefined {
  const hasExplicitCacheConfig =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const family = resolveAnthropicCacheRetentionFamily({
    provider,
    modelApi,
    modelId,
    hasExplicitCacheConfig,
  });

  if (!family) {
    return undefined;
  }

  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }

  return family === "anthropic-direct" ? "short" : undefined;
}
