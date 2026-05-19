import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";

function isOpencodeGoDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

export function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id),
  });
}

// opencode-go/kimi-k2.{5,6} reject any reasoning-shaped field in the request
// body. Stock OpenClaw preserves reasoning_details on replayed assistant
// messages for these model IDs (see REASONING_CONTENT_REPLAY_MODEL_IDS in
// openai-transport-stream.ts), so the provider returns
// `400 Extra inputs are not permitted, field: 'messages[5].reasoning_details'`
// after a few turns. The DeepSeek-V4 wrapper next to this one only handles
// root-level params — the per-message replay needs its own pass. See #83812.
const KIMI_PER_MESSAGE_REASONING_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

function stripPerMessageReasoning(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const record = message as Record<string, unknown>;
  for (const field of KIMI_PER_MESSAGE_REASONING_FIELDS) {
    if (field in record) {
      delete record[field];
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      stripPerMessageReasoning(part);
    }
  }
}

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  delete payloadObj.reasoning;
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
  const messages = payloadObj.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      stripPerMessageReasoning(message);
    }
  }
  const input = payloadObj.input;
  if (Array.isArray(input)) {
    for (const message of input) {
      stripPerMessageReasoning(message);
    }
  }
}

export function createOpencodeGoKimiNoReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoKimiNoReasoningModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, stripReasoningParams);
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  return createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
}
