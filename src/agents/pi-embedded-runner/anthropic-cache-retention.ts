type CacheRetention = "none" | "short" | "long";

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  const isAnthropicDirect = provider === "anthropic";
  const hasBedrockOverride =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const isAnthropicBedrock = provider === "amazon-bedrock" && hasBedrockOverride;

  if (!isAnthropicDirect && !isAnthropicBedrock) {
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
