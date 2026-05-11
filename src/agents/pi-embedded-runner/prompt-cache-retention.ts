import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
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
  baseUrl?: string,
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

  // Determine if this is a verified OpenRouter→Anthropic route using
  // the same endpoint-class gate as createOpenRouterSystemCacheWrapper.
  // This prevents cacheRetention from leaking to arbitrary OpenAI proxies
  // when the OpenRouter provider is repointed at a custom baseUrl.
  const endpointClass = resolveProviderRequestPolicy({
    provider,
    api: modelApi,
    baseUrl,
    capability: "llm",
    transport: "stream",
  }).endpointClass;
  const isOpenRouterAnthropicRoute =
    (endpointClass === "openrouter" ||
      (endpointClass === "default" && provider === "openrouter")) &&
    modelId != null &&
    isAnthropicModelRef(modelId);

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
