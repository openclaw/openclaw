const RESERVED_OPENAI_COMPLETIONS_MODEL_PARAM_KEYS = new Set([
  "__proto__",
  "constructor",
  "model",
  "messages",
  "prototype",
  "stream",
  "stream_options",
  "cacheRetention",
  "cachedContent",
  "cached_content",
  "chatTemplateKwargs",
  "chat_template_kwargs",
  "extraBody",
  "extra_body",
  "fastMode",
  "fast_mode",
  "openaiWsWarmup",
  "reasoningEffort",
  "reasoning_effort",
  "responseCache",
  "responseCacheClear",
  "responseCacheTtl",
  "responseCacheTtlSeconds",
  "response_cache",
  "response_cache_clear",
  "response_cache_ttl",
  "response_cache_ttl_seconds",
  "textVerbosity",
  "text_verbosity",
  "serviceTier",
  "service_tier",
  "transport",
]);

export type OpenAICompletionsModelParamsInput = {
  params?: Record<string, unknown> | null;
};

export function applyOpenAICompletionsModelParams(
  payload: Record<string, unknown>,
  model: OpenAICompletionsModelParamsInput | undefined,
): void {
  const modelParams = model?.params;
  if (!modelParams || typeof modelParams !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(modelParams)) {
    if (value === undefined || RESERVED_OPENAI_COMPLETIONS_MODEL_PARAM_KEYS.has(key)) {
      continue;
    }
    if (key === "max_completion_tokens") {
      delete payload.max_tokens;
    } else if (key === "max_tokens") {
      delete payload.max_completion_tokens;
    }
    payload[key] = value;
  }
}
