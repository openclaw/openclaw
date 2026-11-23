import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isAnthropicFamilyCacheTtlEligible } from "../../llm/providers/stream-wrappers/anthropic-family-cache-semantics.js";
import { resolveProviderCacheTtlEligibility } from "../../plugins/provider-runtime.js";
import type { ProviderCacheTtlEligibilityContext } from "../../plugins/provider-transport.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isGooglePromptCacheEligible } from "./prompt-cache-retention.js";

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

type CacheTtlEntryData = CacheTtlContext & {
  timestamp: number;
};

type CacheTtlContext = {
  provider?: string;
  modelId?: string;
};

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
    (normalizedProvider === "kilocode" && normalizedModelId.startsWith("anthropic/")) ||
    isGooglePromptCacheEligible({ modelApi, modelId: normalizedModelId })
  );
}

/**
 * Cache reads that leave no transcript entry (keep-warm prewarms), by transcript session id.
 * The cache clock owns them beside the transcript marker; they live only in this process,
 * so after a restart the clock falls back to the transcript.
 */
const promptCacheTouches = resolveGlobalSingleton(
  Symbol.for("openclaw.promptCacheTouches"),
  () => new Map<string, Required<CacheTtlContext> & { timestamp: number }>(),
);

/** Records a request start that read the session's cached prefix without a transcript write. */
export function recordPromptCacheTouch(
  sessionId: string,
  touch: Required<CacheTtlContext> & { timestamp: number },
): void {
  promptCacheTouches.delete(sessionId);
  promptCacheTouches.set(sessionId, touch);
  // Oldest first: one entry per recently warmed session is enough.
  for (const key of promptCacheTouches.keys()) {
    if (promptCacheTouches.size <= 1024) {
      break;
    }
    promptCacheTouches.delete(key);
  }
}

function matchesCacheTtlContext(
  data: Partial<CacheTtlContext> | undefined,
  context: CacheTtlContext | undefined,
): boolean {
  return (
    !context ||
    (["provider", "modelId"] as const).every((key) => {
      const expected = normalizeOptionalLowercaseString(context[key]);
      return !expected || normalizeOptionalLowercaseString(data?.[key]) === expected;
    })
  );
}

/** The latest recorded prewarm of this session on the route, if this process sent one. */
export function readPromptCacheTouch(sessionId: string, context: CacheTtlContext): number | null {
  const touch = promptCacheTouches.get(sessionId);
  return touch && matchesCacheTtlContext(touch, context) ? touch.timestamp : null;
}

/**
 * Last cache touch of this session on the route: the transcript marker, moved forward by a
 * later recorded prewarm. No marker means no clock, as before.
 */
export function readLastCacheTtlTimestamp(
  sessionManager: unknown,
  context?: CacheTtlContext,
): number | null {
  try {
    const sm = sessionManager as {
      getEntries?: () => CustomEntryLike[];
      getSessionId?: () => string;
    };
    const touch = sm?.getSessionId ? promptCacheTouches.get(sm.getSessionId()) : undefined;
    const touchedAt = touch && matchesCacheTtlContext(touch, context) ? touch.timestamp : 0;
    const entries = sm?.getEntries ? sm.getEntries() : [];
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
        return Math.max(ts, touchedAt);
      }
    }
    return null;
  } catch {
    return null;
  }
}
