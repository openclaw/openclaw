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

function stripReasoningFieldsFromMessage(msg: unknown): void {
  if (!msg || typeof msg !== "object") {
    return;
  }
  const record = msg as Record<string, unknown>;

  // Strip reasoning fields from message
  delete record.reasoning_details;
  delete record.reasoning_content;
  delete record.reasoning;
  delete record.reasoning_text;

  // Recursively strip from content array
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      stripReasoningFieldsFromMessage(part);
    }
  }
}

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  // Strip root-level reasoning fields
  delete payloadObj.reasoning;
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
  delete payloadObj.include;

  // Strip reasoning fields from messages array
  if (Array.isArray(payloadObj.messages)) {
    for (const msg of payloadObj.messages) {
      stripReasoningFieldsFromMessage(msg);
    }
  }

  // Strip reasoning fields from input array (alternative message container)
  if (Array.isArray(payloadObj.input)) {
    for (const msg of payloadObj.input) {
      stripReasoningFieldsFromMessage(msg);
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
