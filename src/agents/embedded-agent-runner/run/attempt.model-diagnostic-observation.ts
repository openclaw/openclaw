import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DiagnosticModelCallContent } from "../../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  type DiagnosticModelContentCapturePolicy,
} from "../../../infra/diagnostic-llm-content.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../../../infra/diagnostic-semantic-run-progress.js";
import { createModelCallStreamProgressReporter } from "../../../logging/diagnostic-model-stream-progress.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../../usage.js";
import type {
  ModelCallEventBase,
  ModelCallObservationState,
  ModelCallObserver,
  ModelCallPromptStats,
  ModelCallUsage,
} from "./attempt.model-diagnostic-lifecycle.js";

const MODEL_CALL_SEMANTIC_PROGRESS_REASON = "model_call:semantic_result";

function jsonLength(value: unknown, utf8: boolean): number | undefined {
  try {
    let stringLengths = 0;
    const serialized = JSON.stringify(value, (_key, part: unknown) => {
      if (typeof part !== "string" || part.length < 4096) {
        return part;
      }
      // Keep large strings out of the combined JSON allocation. Native encoding
      // still owns escaping, surrogate handling, toJSON, and container semantics.
      const encoded = JSON.stringify(part);
      stringLengths += (utf8 ? Buffer.byteLength(encoded, "utf8") : encoded.length) - 2;
      return "";
    });
    return serialized === undefined
      ? undefined
      : stringLengths + (utf8 ? Buffer.byteLength(serialized, "utf8") : serialized.length);
  } catch {
    return undefined;
  }
}

function utf8JsonByteLength(value: unknown): number | undefined {
  return jsonLength(value, true);
}

function jsonCharLength(value: unknown): number | undefined {
  return jsonLength(value, false);
}

function responseStreamChunkByteLength(chunk: unknown): number | undefined {
  try {
    if (!isRecord(chunk)) {
      return utf8JsonByteLength(chunk);
    }
    const type = chunk.type;
    if (
      (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") &&
      typeof chunk.delta === "string"
    ) {
      return Buffer.byteLength(chunk.delta, "utf8");
    }
    if (!("partial" in chunk)) {
      return utf8JsonByteLength(chunk);
    }
    // Plain stream deltas can carry an accumulated partial snapshot. Byte metrics
    // count the new stream payload, not the answer-so-far replay.
    const { partial: _partial, ...snapshotlessChunk } = chunk;
    return utf8JsonByteLength(snapshotlessChunk);
  } catch {
    return undefined;
  }
}

function streamContextModelContentFields(
  policy: DiagnosticModelContentCapturePolicy | undefined,
  streamContext: unknown,
): DiagnosticModelCallContent | undefined {
  if (!policy?.anyModelContent || !isRecord(streamContext)) {
    return undefined;
  }
  const content = {
    ...(policy.inputMessages && Array.isArray(streamContext.messages)
      ? { inputMessages: cloneDiagnosticContentValue(streamContext.messages) }
      : {}),
    ...(policy.systemPrompt && typeof streamContext.systemPrompt === "string"
      ? { systemPrompt: streamContext.systemPrompt }
      : {}),
    ...(policy.toolDefinitions && Array.isArray(streamContext.tools)
      ? { toolDefinitions: cloneDiagnosticContentValue(streamContext.tools) }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

function streamContextModelPromptStats(streamContext: unknown): ModelCallPromptStats | undefined {
  if (!isRecord(streamContext)) {
    return undefined;
  }
  const messages = Array.isArray(streamContext.messages) ? streamContext.messages : undefined;
  const tools = Array.isArray(streamContext.tools) ? streamContext.tools : undefined;
  const systemPrompt =
    typeof streamContext.systemPrompt === "string" ? streamContext.systemPrompt : undefined;
  const inputMessagesChars = messages ? jsonCharLength(messages) : undefined;
  const toolDefinitionsChars = tools ? jsonCharLength(tools) : undefined;
  const systemPromptChars = systemPrompt?.length;
  if (messages === undefined && tools === undefined && systemPrompt === undefined) {
    return undefined;
  }
  const totalChars =
    (inputMessagesChars ?? 0) + (systemPromptChars ?? 0) + (toolDefinitionsChars ?? 0);
  return {
    ...(messages ? { inputMessagesCount: messages.length } : {}),
    ...(inputMessagesChars !== undefined ? { inputMessagesChars } : {}),
    ...(systemPromptChars !== undefined ? { systemPromptChars } : {}),
    ...(tools ? { toolDefinitionsCount: tools.length } : {}),
    ...(toolDefinitionsChars !== undefined ? { toolDefinitionsChars } : {}),
    totalChars,
  };
}

function normalizedModelCallUsage(rawUsage: unknown): ModelCallUsage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }
  const usage = normalizeUsage(rawUsage as UsageLike);
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  return {
    ...usage,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
  };
}

function observeModelCallTerminalMessage(state: ModelCallObservationState, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  let rawUsage: unknown;
  try {
    rawUsage = value.usage;
    const stopReason = value.stopReason;
    if (
      value.role === "assistant" &&
      (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse")
    ) {
      state.terminalSucceeded = true;
      state.terminalReason = stopReason;
    }
    // The stream contract returns failed assistant messages without throwing.
    // Keep their terminal fact for both iterator and result-only completion.
    // Abort state takes precedence over transport errors raised during cancellation.
    if (value.role === "assistant" && (stopReason === "error" || stopReason === "aborted")) {
      state.terminalReason = stopReason;
      state.terminalError ??= Object.assign(
        new Error(typeof value.errorMessage === "string" ? value.errorMessage : stopReason),
        { code: stopReason === "aborted" ? "ABORT_ERR" : value.errorCode },
      );
    }
  } catch {
    return;
  }
  const usage = normalizedModelCallUsage(rawUsage);
  if (usage) {
    state.usage = usage;
  }
}

function observeOutputMessageContent(state: ModelCallObservationState, chunk: unknown): void {
  if (!isRecord(chunk)) {
    return;
  }
  let type: unknown;
  let message: unknown;
  try {
    type = chunk.type;
    message = type === "done" ? chunk.message : type === "error" ? chunk.error : undefined;
  } catch {
    return;
  }
  // Terminal events carry the final AssistantMessage with usage — `done` for
  // success, `error` for aborted/error streams. Capture usage from either so
  // iterated error-terminated calls still report the per-call usage that the
  // model.call.error event and its OTel span already expose.
  if (message !== undefined) {
    observeModelCallTerminalMessage(state, message);
    if (state.contentCapture?.outputMessages) {
      state.outputMessages = [cloneDiagnosticContentValue(message)];
    }
  }
}

function observeResultMessageContent(
  state: ModelCallObservationState,
  startedAt: number,
  result: unknown,
): void {
  // A result decorator can settle long after the terminal stream chunk. Do not
  // label that bookkeeping delay as new provider activity. Result-only adapters
  // still have an observed response when their result first arrives.
  if (!state.terminalEventEmitted && state.terminalReason === undefined) {
    state.lastProviderActivityAtMs = Date.now();
  }
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  observeModelCallTerminalMessage(state, result);
  if (state.contentCapture?.outputMessages && state.outputMessages === undefined) {
    state.outputMessages = [cloneDiagnosticContentValue(result)];
  }
  if (state.responseStreamBytes === 0) {
    const bytes = utf8JsonByteLength(result);
    if (bytes !== undefined) {
      state.responseStreamBytes = bytes;
    }
  }
}

function isNormalizedToolCall(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "toolCall") {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isRecord(value.arguments)
  );
}

function isSemanticModelCallResult(result: unknown): boolean {
  try {
    if (
      !isRecord(result) ||
      result.role !== "assistant" ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      !Array.isArray(result.content)
    ) {
      return false;
    }
    const hasExecutableToolCall =
      result.stopReason === "toolUse" && result.content.some(isNormalizedToolCall);
    return (
      hasExecutableToolCall ||
      result.content.some(
        (item) =>
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0,
      )
    );
  } catch {
    return false;
  }
}

function maybeEmitModelCallSemanticProgress(
  eventBase: ModelCallEventBase,
  state: ModelCallObservationState,
  result: unknown,
): void {
  if (state.semanticProgressEmitted || !isSemanticModelCallResult(result)) {
    return;
  }
  state.semanticProgressEmitted = true;
  emitCoreSemanticRunProgressDiagnosticEvent({
    runId: eventBase.runId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    reason: MODEL_CALL_SEMANTIC_PROGRESS_REASON,
  });
}

function observeResponseChunk(
  state: ModelCallObservationState,
  startedAt: number,
  chunk: unknown,
): void {
  if (!state.terminalEventEmitted) {
    state.lastProviderActivityAtMs = Date.now();
  }
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  observeOutputMessageContent(state, chunk);
  const bytes = responseStreamChunkByteLength(chunk);
  if (bytes !== undefined) {
    state.responseStreamBytes += bytes;
  }
}

export function createModelObserver(params: {
  config?: OpenClawConfig;
  streamContext: unknown;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  suppressPluginHooks?: boolean;
  capturePromptStats: boolean;
}): ModelCallObserver {
  const modelContent = streamContextModelContentFields(params.contentCapture, params.streamContext);
  const promptStats = params.capturePromptStats
    ? streamContextModelPromptStats(params.streamContext)
    : undefined;
  const state: ModelCallObservationState = {
    responseStreamBytes: 0,
    modelContent,
    contentCapture: params.contentCapture,
    suppressPluginHooks: params.suppressPluginHooks,
  };
  const reportStreamProgress = createModelCallStreamProgressReporter({ config: params.config });
  return {
    state,
    promptStats,
    modelContent,
    assignRequestPayloadBytes(payload) {
      const bytes = utf8JsonByteLength(payload);
      if (bytes !== undefined) {
        state.requestPayloadBytes = bytes;
      }
    },
    observeResponseChunk(startedAt, chunk) {
      observeResponseChunk(state, startedAt, chunk);
    },
    observeFinalResult(eventBase, startedAt, result) {
      observeResultMessageContent(state, startedAt, result);
      // Queue semantic progress beside model lifecycle events so request starts,
      // progress, and the next request retain their authoritative FIFO ordering.
      maybeEmitModelCallSemanticProgress(eventBase, state, result);
    },
    maybeEmitStreamProgress(eventBase) {
      reportStreamProgress({
        ...eventBase,
        callId: state.terminalEventEmitted ? undefined : eventBase.callId,
      });
    },
    sizeTimingFields() {
      return {
        ...(state.requestPayloadBytes !== undefined
          ? { requestPayloadBytes: state.requestPayloadBytes }
          : {}),
        ...(state.responseStreamBytes > 0
          ? { responseStreamBytes: state.responseStreamBytes }
          : {}),
        ...(state.timeToFirstByteMs !== undefined
          ? { timeToFirstByteMs: state.timeToFirstByteMs }
          : {}),
      };
    },
    completedContent() {
      return state.modelContent || state.outputMessages
        ? {
            ...state.modelContent,
            ...(state.outputMessages ? { outputMessages: state.outputMessages } : {}),
          }
        : undefined;
    },
    usageField() {
      return state.usage ? { usage: state.usage } : {};
    },
  };
}
