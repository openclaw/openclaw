import type { ProviderAcceptance } from "@openclaw/ai/transports";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  DiagnosticEventInput,
  DiagnosticModelCallContent,
} from "../../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  type DiagnosticModelContentCapturePolicy,
} from "../../../infra/diagnostic-llm-content.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../../../infra/diagnostic-semantic-run-progress.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { StreamFn } from "../../runtime/index.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../../usage.js";

type ModelCallRequestContext = Partial<Parameters<StreamFn>[1]>;

export type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallPromptStats = NonNullable<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>["promptStats"]
>;
type ModelCallUsage = NonNullable<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>["usage"]
>;
type ModelCallObservationState = {
  requestPayloadBytes?: number;
  providerAcceptanceKind?: ProviderAcceptance["kind"];
  responseStatus?: number;
  responseStreamBytes: number;
  /** Observed provider callbacks/chunks, not recovery or visible-content progress. */
  lastProviderActivityAtMs?: number;
  terminalReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  timeToFirstByteMs?: number;
  providerProcessingMs?: number;
  modelContent?: DiagnosticModelCallContent;
  outputMessages?: unknown[];
  usage?: ModelCallUsage;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  semanticProgressEmitted?: boolean;
  terminalEventEmitted?: boolean;
  terminalError?: Error;
  terminalSucceeded?: boolean;
  suppressPluginHooks?: boolean;
};

const MODEL_CALL_SEMANTIC_PROGRESS_REASON = "model_call:semantic_result";

function jsonStringContentLength(text: string, utf8: boolean): number {
  let length = utf8 ? Buffer.byteLength(text, "utf8") : text.length;
  // oxlint-disable-next-line no-control-regex -- JSON escapes U+0000 through U+001F.
  const firstEscape = text.search(/[\u0000-\u001f"\\\ud800-\udfff]/u);
  for (let index = firstEscape; index >= 0 && index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    ) {
      length++;
    } else if (code < 0x20) {
      length += 5;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(index + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        index++;
      } else {
        // JSON escapes lone surrogates; UTF-8 otherwise counts a three-byte replacement.
        length += utf8 ? 3 : 5;
      }
    }
  }
  return length;
}

function jsonLength(value: unknown, utf8: boolean): number | undefined {
  try {
    let stringLengths = 0;
    const serialized = JSON.stringify(value, (_key, part: unknown) => {
      if (typeof part !== "string" || part.length < 4096) {
        return part;
      }
      // Count large strings without allocating quoted copies. Native JSON still
      // owns toJSON, property omission, keys, and container semantics.
      stringLengths += jsonStringContentLength(part, utf8);
      return "";
    });
    return serialized === undefined
      ? undefined
      : stringLengths + (utf8 ? Buffer.byteLength(serialized, "utf8") : serialized.length);
  } catch {
    return undefined;
  }
}

function responseStreamChunkByteLength(chunk: unknown): number | undefined {
  try {
    if (!isRecord(chunk)) {
      return jsonLength(chunk, true);
    }
    const type = chunk.type;
    if (
      (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") &&
      typeof chunk.delta === "string"
    ) {
      return Buffer.byteLength(chunk.delta, "utf8");
    }
    if (!("partial" in chunk)) {
      return jsonLength(chunk, true);
    }
    // Plain stream deltas can carry an accumulated partial snapshot. Byte metrics
    // count the new stream payload, not the answer-so-far replay.
    const { partial: _partial, ...snapshotlessChunk } = chunk;
    return jsonLength(snapshotlessChunk, true);
  } catch {
    return undefined;
  }
}

function streamContextModelContentFields(
  policy: DiagnosticModelContentCapturePolicy | undefined,
  streamContext: ModelCallRequestContext,
): DiagnosticModelCallContent | undefined {
  if (!policy?.anyModelContent) {
    return undefined;
  }
  const content = {
    ...(policy.inputMessages && streamContext.messages
      ? { inputMessages: cloneDiagnosticContentValue(streamContext.messages) }
      : {}),
    ...(policy.systemPrompt && streamContext.systemPrompt !== undefined
      ? { systemPrompt: streamContext.systemPrompt }
      : {}),
    ...(policy.toolDefinitions && streamContext.tools
      ? { toolDefinitions: cloneDiagnosticContentValue(streamContext.tools) }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

function streamContextModelPromptStats(
  streamContext: ModelCallRequestContext,
): ModelCallPromptStats | undefined {
  const { messages, tools, systemPrompt } = streamContext;
  const inputMessagesChars = messages ? jsonLength(messages, false) : undefined;
  const toolDefinitionsChars = tools ? jsonLength(tools, false) : undefined;
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

function observeModelCallTerminalMessage(state: ModelCallObservationState, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  let rawUsage: unknown;
  try {
    rawUsage = value.usage;
    const timing = Array.isArray(value.diagnostics)
      ? value.diagnostics.findLast(
          (entry: unknown) => isRecord(entry) && entry.type === "provider_timing",
        )
      : undefined;
    if (isRecord(timing) && isRecord(timing.details)) {
      state.providerProcessingMs = asNonNegativeFiniteNumber(timing.details.processingMs);
    }
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
  const usage = isRecord(rawUsage) ? normalizeUsage(rawUsage as UsageLike) : undefined;
  if (usage) {
    const promptTokens = derivePromptTokens(usage);
    state.usage = { ...usage, ...(promptTokens !== undefined ? { promptTokens } : {}) };
  }
}

function observeOutputMessageContent(state: ModelCallObservationState, chunk: unknown): void {
  if (!isRecord(chunk)) {
    return;
  }
  let message: unknown;
  try {
    const type = chunk.type;
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

function observeModelResponse(
  state: ModelCallObservationState,
  startedAt: number,
  value: unknown,
  kind: "chunk" | "result",
): void {
  // A result decorator can settle long after the terminal stream chunk. Do not
  // label that bookkeeping delay as new provider activity. Result-only adapters
  // still have an observed response when their result first arrives.
  if (!state.terminalEventEmitted && (kind === "chunk" || state.terminalReason === undefined)) {
    state.lastProviderActivityAtMs = Date.now();
  }
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  if (kind === "chunk") {
    observeOutputMessageContent(state, value);
  } else {
    observeModelCallTerminalMessage(state, value);
    if (state.contentCapture?.outputMessages && state.outputMessages === undefined) {
      state.outputMessages = [cloneDiagnosticContentValue(value)];
    }
  }
  if (kind === "chunk" || state.responseStreamBytes === 0) {
    const bytes = kind === "chunk" ? responseStreamChunkByteLength(value) : jsonLength(value, true);
    if (bytes !== undefined) {
      state.responseStreamBytes += bytes;
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

export function createModelObserver(params: {
  diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  config?: OpenClawConfig;
  streamContext: ModelCallRequestContext;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  suppressPluginHooks?: boolean;
  capturePromptStats: boolean;
}) {
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
  return {
    state,
    promptStats,
    modelContent,
    assignRequestPayloadBytes(payload: unknown) {
      const bytes = jsonLength(payload, true);
      if (bytes !== undefined) {
        state.requestPayloadBytes = bytes;
      }
    },
    observeResponseChunk(startedAt: number, chunk: unknown) {
      observeModelResponse(state, startedAt, chunk, "chunk");
    },
    observeFinalResult(eventBase: ModelCallEventBase, startedAt: number, result: unknown) {
      observeModelResponse(state, startedAt, result, "result");
      // Queue semantic progress beside model lifecycle events so request starts,
      // progress, and the next request retain their authoritative FIFO ordering.
      if (!state.semanticProgressEmitted && isSemanticModelCallResult(result)) {
        state.semanticProgressEmitted = true;
        emitCoreSemanticRunProgressDiagnosticEvent(
          {
            runId: eventBase.runId,
            ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
            ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
            reason: MODEL_CALL_SEMANTIC_PROGRESS_REASON,
          },
          params.diagnosticOwner,
        );
      }
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
