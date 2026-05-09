import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  isAnthropicModelRef,
  resolveAnthropicCacheRetentionFamily,
} from "./anthropic-family-cache-semantics.js";

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

  // Determine if this is a verified OpenRouter→Anthropic route.
  // OpenRouter uses the "openai-completions" API and the model ref
  // starts with "anthropic/". This mirrors the endpoint-class +
  // model-ref check in createOpenRouterSystemCacheWrapper.
  const isOpenRouterAnthropicRoute =
    provider === "openrouter" && modelId != null && isAnthropicModelRef(modelId);

  const isEligible = !!family || googleEligible || isOpenRouterAnthropicRoute;

  if (hasExplicitCacheConfig && isEligible) {
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
  }

  if (!family && !googleEligible) {
    return undefined;
  }

  return family === "anthropic-direct" ? "short" : undefined;
}
