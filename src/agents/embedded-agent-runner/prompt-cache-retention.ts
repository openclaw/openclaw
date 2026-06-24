/**
 * Resolves provider/model prompt-cache retention behavior.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAnthropicCacheRetentionFamily } from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";

type CacheRetention = "none" | "short" | "long";

const BEDROCK_NOVA_PROMPT_CACHE_MODEL_RE =
  /(?:^|-)amazon-nova-(?:micro|lite|pro|premier|2-lite)(?:-|$)|^nova-(?:micro|lite|pro|premier|2-lite)(?:-|$)/;

function isBedrockNovaPromptCacheEligible(params: { provider: string; modelId?: string }): boolean {
  if (
    normalizeLowercaseStringOrEmpty(params.provider) !== "amazon-bedrock" ||
    typeof params.modelId !== "string" ||
    params.modelId.length === 0
  ) {
    return false;
  }
  return BEDROCK_NOVA_PROMPT_CACHE_MODEL_RE.test(
    normalizeLowercaseStringOrEmpty(params.modelId).replace(/[\s_.:]+/g, "-"),
  );
}

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
  // could emit it. Bedrock Nova models use the same OpenAI-compatible wire but
  // have provider-native cache points, so explicit user retention also needs
  // to survive this shared resolver.
  const cacheKeyEligible = supportsPromptCacheKey === true;
  const bedrockNovaEligible =
    hasExplicitCacheConfig && isBedrockNovaPromptCacheEligible({ provider, modelId });

  if (!family && !googleEligible && !cacheKeyEligible && !bedrockNovaEligible) {
    return undefined;
  }

  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
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
