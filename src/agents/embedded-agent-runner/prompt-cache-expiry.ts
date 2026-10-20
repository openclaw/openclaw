import { usesOpenAIMinimumCacheLifetime } from "@openclaw/ai/internal/openai";
import {
  isDirectAnthropicModel,
  isNativeOpenAIEndpoint,
  resolveAnthropicCacheOptions,
} from "@openclaw/ai/transports";
import type { Model } from "../../llm/types.js";
import type { NormalizedUsage } from "../usage.js";

/** A scheduling estimate, not proof that an entry exists or expires at this instant. */
export type PromptCacheExpiryEstimate = {
  observedAt: number;
  windowMs: number;
  basis: "anthropic-ttl" | "openai-minimum";
};

/** Only qualified conversation-prefix caches: never infer a TTL from a provider label alone. */
export function estimatePromptCacheExpiry(params: {
  model: Model;
  authMode?: string;
  retention?: "none" | "short" | "long";
  usage?: NormalizedUsage;
  requestStartedAt?: number;
  now?: number;
}): PromptCacheExpiryEstimate | undefined {
  const { model, retention, usage, requestStartedAt } = params;
  const now = params.now ?? Date.now();
  if (
    params.authMode !== "api-key" ||
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
  // The payload owner applies explicit retention, endpoint defaults and compatibility overrides.
  if (model.api === "anthropic-messages" && isDirectAnthropicModel(model)) {
    const { cacheControl } = resolveAnthropicCacheOptions(
      { ...model, api: "anthropic-messages" },
      retention,
    );
    if (cacheControl) {
      return {
        observedAt: requestStartedAt,
        windowMs: "ttl" in cacheControl && cacheControl.ttl === "1h" ? 3_600_000 : 300_000,
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
    return { observedAt: requestStartedAt, windowMs: 1_800_000, basis: "openai-minimum" };
  }
  // Legacy OpenAI lifetimes are variable, not 24h deadlines. ChatGPT sign-in,
  // proxies, Bedrock and Vertex have distinct contracts; Gemini resources cache
  // the stable system/tools, not the conversation being compacted. No guessed timer.
  return undefined;
}
