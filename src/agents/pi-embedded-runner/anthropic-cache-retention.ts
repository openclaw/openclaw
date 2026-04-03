type CacheRetention = "none" | "short" | "long";

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelApi?: string,
): CacheRetention | undefined {
  const isAnthropicDirect = provider === "anthropic";
  const hasExplicitCacheConfig =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const isAnthropicBedrock = provider === "amazon-bedrock" && hasExplicitCacheConfig;
  const isCustomAnthropicApi =
    !isAnthropicDirect &&
    !isAnthropicBedrock &&
    modelApi === "anthropic-messages" &&
    hasExplicitCacheConfig;

  if (!isAnthropicDirect && !isAnthropicBedrock && !isCustomAnthropicApi) {
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

  return isAnthropicDirect ? "short" : undefined;
}
