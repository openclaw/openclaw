// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";
import {
  createOpencodeGoStalledStreamWrapper,
  OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
} from "./stream-termination.js";

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

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  stripOpencodeGoKimiReasoningPayload(payloadObj);
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

// Minimax models using the Anthropic Messages path through opencode-go return
// thinking content as regular text blocks rather than proper type:"thinking"
// Anthropic blocks. Disable thinking at the request level for these models
// to prevent internal reasoning from leaking to channel output.
function isOpencodeGoMinimaxAnthropicModelId(modelId: unknown): boolean {
  return typeof modelId === "string" && modelId.trim().toLowerCase() === "minimax-m3";
}

function injectMinimaxThinkingDisabled(payloadObj: Record<string, unknown>): void {
  payloadObj.thinking = { type: "disabled" };
}

export function createOpencodeGoMinimaxNoThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoMinimaxAnthropicModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      options,
      injectMinimaxThinkingDisabled,
    );
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const minimaxWrapped = createOpencodeGoMinimaxNoThinkingWrapper(baseStreamFn) ?? baseStreamFn;
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(minimaxWrapped) ?? minimaxWrapped;
  const deepSeekWrapped =
    createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(deepSeekWrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}
