import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveAnthropicCacheRetentionFamily } from "./anthropic-family-cache-semantics.js";

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

  // Honor an explicit user-provided cacheRetention regardless of provider
  // family. OpenAI-compatible completions backends (oMLX, llama.cpp, etc.)
  // opt in to prompt caching via compat.supportsPromptCacheKey: true, and
  // their users set cacheRetention to control prefix caching. Dropping the
  // explicit value silently here meant the transport layer never received
  // the user's choice (issue #81281).
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

  if (!family && !googleEligible) {
    return undefined;
  }

  return family === "anthropic-direct" ? "short" : undefined;
}
