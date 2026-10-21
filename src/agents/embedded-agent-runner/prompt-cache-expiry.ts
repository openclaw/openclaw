import {
  resolveOpenAIPromptCacheParams,
  usesOpenAIMinimumCacheLifetime,
} from "@openclaw/ai/internal/openai";
import {
  isDirectAnthropicModel,
  isNativeOpenAIEndpoint,
  resolveAnthropicCacheOptions,
  resolveOpenAICompletionsCompat,
  usesNativeOpenAICodexResponsesBackend,
} from "@openclaw/ai/transports";
import type { Model } from "../../llm/types.js";
import type { NormalizedUsage } from "../usage.js";
import { parsePromptCacheTtl } from "./prompt-cache-retention.js";

/** A scheduling estimate, not proof that an entry exists or expires at this instant. */
export type PromptCacheExpiryEstimate = {
  observedAt: number;
  windowMs: number;
  basis: "anthropic-ttl" | "openai-minimum" | "codex-idle-heuristic";
};

/** Only conversation-prefix caches eligible for pre-expiry compaction; short TTLs are excluded. */
export function estimatePromptCacheExpiry(params: {
  model: Model;
  authMode?: string;
  retention?: "none" | "short" | "long";
  promptCacheTtl?: unknown;
  usage?: NormalizedUsage;
  requestStartedAt?: number;
  now?: number;
}): PromptCacheExpiryEstimate | undefined {
  const { model, retention, usage, requestStartedAt } = params;
  const now = params.now ?? Date.now();
  if (
    retention === "none" ||
    usage?.cacheTelemetry?.state === "unavailable" ||
    !((usage?.cacheRead ?? 0) > 0 || (usage?.cacheWrite ?? 0) > 0) ||
    requestStartedAt === undefined ||
    !Number.isFinite(requestStartedAt) ||
    requestStartedAt <= 0 ||
    requestStartedAt > now
  ) {
    return undefined;
  }
  if (
    params.authMode === "oauth" &&
    usesNativeOpenAICodexResponsesBackend(model) &&
    URL.parse(model.baseUrl)?.origin === "https://chatgpt.com"
  ) {
    // Opt-in idle policy, not a provider TTL: start the assumed window at the
    // completed model activity, rather than treating request duration as idle.
    return { observedAt: now, windowMs: 1_800_000, basis: "codex-idle-heuristic" };
  }
  if (params.authMode !== "api-key") {
    return undefined;
  }
  // The payload owner applies explicit retention, endpoint defaults and compatibility overrides.
  if (model.api === "anthropic-messages" && isDirectAnthropicModel(model)) {
    const { cacheControl } = resolveAnthropicCacheOptions(
      { ...model, api: "anthropic-messages" },
      retention,
    );
    if (cacheControl && "ttl" in cacheControl && cacheControl.ttl === "1h") {
      return {
        observedAt: requestStartedAt,
        windowMs: 3_600_000,
        basis: "anthropic-ttl",
      };
    }
  }
  if (
    (model.api === "openai-responses" || model.api === "openai-completions") &&
    Boolean(model.baseUrl?.trim()) &&
    isNativeOpenAIEndpoint(model) &&
    usesOpenAIMinimumCacheLifetime(model.id)
  ) {
    const compat = resolveOpenAICompletionsCompat(model);
    if (!compat.supportsPromptCacheKey) {
      return undefined;
    }
    const policy = resolveOpenAIPromptCacheParams(
      model,
      retention ?? "short",
      compat,
      model.api === "openai-responses" ? parsePromptCacheTtl(params.promptCacheTtl) : undefined,
    );
    // Omitted or unsupported overrides retain the native model's default minimum.
    return {
      observedAt: requestStartedAt,
      windowMs: policy.prompt_cache_options?.ttl === "12h" ? 43_200_000 : 1_800_000,
      basis: "openai-minimum",
    };
  }
  // Legacy OpenAI lifetimes are variable, not 24h deadlines. Proxies,
  // Bedrock and Vertex have distinct contracts; Gemini resources cache
  // the stable system/tools, not the conversation being compacted. No guessed timer.
  return undefined;
}
