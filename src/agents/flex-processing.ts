import { normalizeThinkLevel, THINKING_LEVEL_RANKS } from "../auto-reply/thinking.shared.js";
import {
  normalizeOpenAIFastMode,
  normalizeOpenAIServiceTier,
} from "../llm/providers/openai-fast-mode.js";

export const FLEX_PROCESSING_LLM_TIMEOUT_MS = 10 * 60 * 1000;
export const FLEX_PROCESSING_RETRY_POLICY = {
  maxRetries: 4,
  retryWindowMs: 30 * 60 * 1000,
  baseDelayMs: 60 * 1000,
  maxDelayMs: 10 * 60 * 1000,
};

/** Prepare the runtime opt-in after provider, agent, and per-request overrides. */
export function prepareFlexProcessingParams(params: {
  model: { provider: string; api?: string; baseUrl?: string };
  thinkingLevel?: string;
  extraParams: Record<string, unknown>;
}) {
  if (params.model.provider !== "openai") {
    return { extraParams: params.extraParams, isFlexProcessing: () => false };
  }
  const { flexProcessing, ...extraParams } = params.extraParams;
  const thinking = normalizeThinkLevel(params.thinkingLevel);
  const endpoint = params.model.baseUrl ? URL.parse(params.model.baseUrl) : undefined;
  const eligible =
    flexProcessing === true &&
    params.model.api === "openai-responses" &&
    (!params.model.baseUrl ||
      (endpoint?.protocol === "https:" &&
        (endpoint.hostname === "api.openai.com" || endpoint.hostname.endsWith(".api.openai.com"))));
  if (
    eligible &&
    thinking !== undefined &&
    THINKING_LEVEL_RANKS[thinking] >= THINKING_LEVEL_RANKS.high &&
    !Object.hasOwn(extraParams, "serviceTier") &&
    !Object.hasOwn(extraParams, "service_tier")
  ) {
    extraParams.serviceTier = "flex";
  }
  return {
    extraParams,
    // Fast mode may change between physical requests in the same turn. Use
    // the transport's tier precedence rather than the inherited config tier.
    isFlexProcessing: () =>
      eligible &&
      normalizeOpenAIServiceTier(extraParams.serviceTier ?? extraParams.service_tier) === "flex" &&
      normalizeOpenAIFastMode(extraParams.fastMode ?? extraParams.fast_mode) === undefined,
  };
}
