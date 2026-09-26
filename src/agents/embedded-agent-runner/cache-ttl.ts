/**
 * Resolves cache-TTL eligibility and session markers for prompt-cache retention.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isAnthropicFamilyCacheTtlEligible,
  isAnthropicModelRef,
} from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";
import { resolveProviderCacheTtlEligibility } from "../../plugins/provider-runtime.js";
import type { ProviderCacheTtlEligibilityContext } from "../../plugins/provider-transport.types.js";
import { isGooglePromptCacheEligible } from "./prompt-cache-retention.js";

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

type CacheTtlContext = {
  provider?: string;
  modelId?: string;
};

/** Returns whether this provider/model pair supports cache-TTL session markers. */
export function isCacheTtlEligibleProvider(
  provider: string,
  modelId: string,
  modelApi?: string,
  route?: Pick<ProviderCacheTtlEligibilityContext, "baseUrl" | "supportsPromptCacheKey">,
): boolean {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const pluginEligibility = resolveProviderCacheTtlEligibility({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: normalizedModelId,
      modelApi,
      baseUrl: route?.baseUrl,
      supportsPromptCacheKey: route?.supportsPromptCacheKey,
    },
  });
  if (pluginEligibility !== undefined) {
    return pluginEligibility;
  }
  return (
    // Config-only OpenAI-compatible providers have no hook; require an explicit opt-in.
    (route?.supportsPromptCacheKey === true &&
      (modelApi === "openai-responses" ||
        modelApi === "openai-completions" ||
        modelApi === "openai-chatgpt-responses")) ||
    isAnthropicFamilyCacheTtlEligible({
      provider: normalizedProvider,
      modelId: normalizedModelId,
      modelApi,
    }) ||
    (normalizedProvider === "kilocode" && isAnthropicModelRef(normalizedModelId)) ||
    isGooglePromptCacheEligible({ modelApi, modelId: normalizedModelId })
  );
}

function matchesCacheTtlContext(
  data: Partial<CacheTtlEntryData> | undefined,
  context: CacheTtlContext | undefined,
): boolean {
  if (!context) {
    return true;
  }
  const expectedProvider = normalizeOptionalLowercaseString(context.provider);
  if (expectedProvider && normalizeOptionalLowercaseString(data?.provider) !== expectedProvider) {
    return false;
  }
  const expectedModelId = normalizeOptionalLowercaseString(context.modelId);
  if (expectedModelId && normalizeOptionalLowercaseString(data?.modelId) !== expectedModelId) {
    return false;
  }
  return true;
}

/** Transcript entries visible to cache-TTL marker readers; stores without entries read as empty. */
function readCacheTtlEntries(sessionManager: unknown): CustomEntryLike[] {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  return sm?.getEntries ? sm.getEntries() : [];
}

/** Reads the most recent cache-TTL marker that matches the optional provider/model context. */
export function readLastCacheTtlTimestamp(
  sessionManager: unknown,
  context?: CacheTtlContext,
): number | null {
  try {
    const entries = readCacheTtlEntries(sessionManager);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      if (!matchesCacheTtlContext(data, context)) {
        continue;
      }
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        return ts;
      }
    }
    return null;
  } catch {
    return null;
  }
}
