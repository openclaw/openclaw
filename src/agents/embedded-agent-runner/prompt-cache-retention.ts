/**
 * Resolves provider/model prompt-cache retention behavior.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAnthropicCacheRetentionFamily } from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";

type CacheRetention = "none" | "short" | "long";

export function parseCacheRetention(value: unknown): CacheRetention | undefined {
  return value === "none" || value === "short" || value === "long" ? value : undefined;
}

export function modelSupportsExplicitCacheRetention(model: unknown): boolean {
  const compat = (model as { compat?: unknown } | null | undefined)?.compat;
  if (!compat || typeof compat !== "object") {
    return false;
  }
  const record = compat as Record<string, unknown>;
  return record.supportsPromptCacheKey === true || record.supportsCacheRetention === true;
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
  supportsExplicitCacheRetention?: boolean,
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
  // Providers outside the Anthropic/Google families can declare that their
  // resolved model accepts explicit cache retention. The provider owns the
  // model-family decision; this shared resolver only consumes the capability.
  const providerCapabilityEligible =
    hasExplicitCacheConfig && supportsExplicitCacheRetention === true;

  if (!family && !googleEligible && !providerCapabilityEligible) {
    return undefined;
  }

  const newVal = parseCacheRetention(extraParams?.cacheRetention);
  if (newVal) {
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
