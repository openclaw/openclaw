import { beginPromptCacheObservation } from "./prompt-cache-observability.js";

type ObservationParams = Parameters<typeof beginPromptCacheObservation>[0];

export function beginOpenAIObservation(
  params: Pick<ObservationParams, "sessionId"> & Partial<ObservationParams>,
) {
  return beginPromptCacheObservation({
    messages: [],
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    streamStrategy: "boundary-aware:openai-responses",
    systemPrompt: "stable system",
    tools: [{ name: "read" }],
    ...params,
  });
}

export function beginAnthropicObservation(
  params: Pick<ObservationParams, "sessionId"> & Partial<ObservationParams>,
) {
  return beginPromptCacheObservation({
    messages: [],
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    modelApi: "anthropic-messages",
    streamStrategy: "boundary-aware:anthropic-messages",
    systemPrompt: "stable system",
    tools: [{ name: "read" }],
    ...params,
  });
}
