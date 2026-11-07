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

/** Follow the effective tier after provider, agent, and per-request overrides. */
export function isFlexProcessingRequest(params: {
  model: { provider: string; api?: string; baseUrl?: string };
  extraParams: Record<string, unknown>;
}): boolean {
  const { model, extraParams } = params;
  const endpoint = model.baseUrl ? URL.parse(model.baseUrl) : undefined;
  return (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    (!model.baseUrl ||
      (endpoint?.protocol === "https:" &&
        (endpoint.hostname === "api.openai.com" ||
          endpoint.hostname.endsWith(".api.openai.com")))) &&
    normalizeOpenAIServiceTier(extraParams.serviceTier ?? extraParams.service_tier) === "flex" &&
    normalizeOpenAIFastMode(extraParams.fastMode ?? extraParams.fast_mode) === undefined
  );
}
