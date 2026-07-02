/**
 * Resolves provider/model prompt-cache retention behavior.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAnthropicCacheRetentionFamily } from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";

type CacheRetention = "none" | "short" | "long";

export function isGooglePromptCacheEligible(params: {
  modelApi?: string;
  modelId?: string;
}): boolean {
  if (params.modelApi !== "google-generative-ai") {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return normalizedModelId.startsWith("gemini-2.5") || normalizedModelId.startsWith("gemini-3");
}

export function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelApi?: string,
  modelId?: string,
  supportsPromptCacheKey?: boolean,
): CacheRetention | undefined {
  const hasExplicitCacheConfig =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const family = resolveAnthropicCacheRetentionFamily({
    provider,
    modelApi,
    modelId,
    hasExplicitCacheConfig,
  });
  const googleEligible = isGooglePromptCacheEligible({ modelApi, modelId });
  // OpenAI-compatible completions backends (oMLX, llama.cpp, etc.) opt into
  // prompt caching via `compat.supportsPromptCacheKey: true`. Without that
  // flag they sit outside the anthropic/google family gates, so issue #81281
  // dropped the user's explicit `cacheRetention` before the transport layer
  // could emit it. Proxies that route non-cacheable models via the same
  // openai-completions wire (amazon-bedrock + amazon.* nova models) leave
  // the flag unset, so the existing family gate still applies to them.
  const cacheKeyEligible = supportsPromptCacheKey === true;

  if (!family && !googleEligible && !cacheKeyEligible) {
    return undefined;
  }

  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }
  // Anthropic API docs accept "standard" as a cache retention synonym for
  // "short". Normalize it only within the Anthropic family gate so Google and
  // prompt-cache-key providers are unaffected.
  if (newVal === "standard" && family) {
    return "short";
  }

  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m" && (family || googleEligible)) {
    return "short";
  }
  if (legacy === "1h" && (family || googleEligible)) {
    return "long";
  }

  return family === "anthropic-direct" ? "short" : undefined;
}
