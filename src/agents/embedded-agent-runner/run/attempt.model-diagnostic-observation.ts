import type { ProviderAcceptance } from "@openclaw/ai/transports";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isOwnedTranscriptPayload } from "../../../config/sessions/transcript-json.js";
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
  reasoningSuppressed?: boolean;
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

type PromptStringLengths = Map<string, WeakMap<object, { text: string; chars: number }>>;
type PromptStringLengthPass = {
  previous: PromptStringLengths;
  current: PromptStringLengths;
  owned: WeakMap<object, number>;
};

function jsonLength(
  value: unknown,
  utf8: boolean,
  promptStringLengths?: PromptStringLengthPass,
): number | undefined {
  try {
    let omittedChars = 0;
    const serialized = JSON.stringify(value, function (this: object, key, part: unknown) {
      if (
        !utf8 &&
        promptStringLengths &&
        part !== null &&
        typeof part === "object" &&
        isOwnedTranscriptPayload(part)
      ) {
        const chars = promptStringLengths.owned.get(part) ?? jsonLength(part, false);
        if (chars !== undefined) {
          promptStringLengths.owned.set(part, chars);
          // Owned roots are deeply frozen JSON. Native serialization still owns
          // the surrounding keys, separators and mutable envelope semantics.
          omittedChars += chars - 2;
          return "";
        }
      }
      if (typeof part !== "string" || part.length < 4096) {
        return part;
      }
      const cached = !utf8 ? promptStringLengths?.previous.get(key)?.get(this) : undefined;
      // Keep large strings out of the combined JSON allocation. Native encoding
      // still owns escaping, surrogate handling, toJSON, and container semantics.
      let chars = cached?.text === part ? cached.chars : undefined;
      if (chars === undefined) {
        const encoded = JSON.stringify(part);
        chars = (utf8 ? Buffer.byteLength(encoded, "utf8") : encoded.length) - 2;
      }
      if (!utf8 && promptStringLengths) {
        const holders = promptStringLengths.current.get(key) ?? new WeakMap();
        holders.set(this, cached?.text === part ? cached : { text: part, chars });
        promptStringLengths.current.set(key, holders);
      }
      omittedChars += chars;
      return "";
    });
    return serialized === undefined
      ? undefined
      : omittedChars + (utf8 ? Buffer.byteLength(serialized, "utf8") : serialized.length);
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

export function createModelPromptStats() {
  // Share each field's weak holder index across messages within this attempt.
  // Exact text is its revision; walk containers to observe compaction and hook edits.
  let previous: PromptStringLengths = new Map();
  const owned = new WeakMap<object, number>();
  return (streamContext: ModelCallRequestContext) => {
    const current: PromptStringLengths = new Map();
    const stats = streamContextModelPromptStats(streamContext, { previous, current, owned });
    // Drop deleted fields and compacted history even if their holders remain alive.
    previous = current;
    return stats;
  };
}

function streamContextModelPromptStats(
  streamContext: ModelCallRequestContext,
  promptStringLengths?: PromptStringLengthPass,
): ModelCallPromptStats | undefined {
  const { messages, tools, systemPrompt } = streamContext;
  const inputMessagesChars = messages
    ? jsonLength(messages, false, promptStringLengths)
    : undefined;
  const toolDefinitionsChars = tools ? jsonLength(tools, false, promptStringLengths) : undefined;
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
    state.reasoningSuppressed ||=
      value.role === "assistant" &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.some(
        (entry: unknown) => isRecord(entry) && entry.type === "reasoning_suppressed",
      );
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
  captureByteStats: boolean,
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
  if (captureByteStats && (kind === "chunk" || state.responseStreamBytes === 0)) {
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
  streamContext: ModelCallRequestContext;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  suppressPluginHooks?: boolean;
  capturePromptStats: boolean;
  captureByteStats: boolean;
  measurePromptStats?: ReturnType<typeof createModelPromptStats>;
}) {
  const modelContent = streamContextModelContentFields(params.contentCapture, params.streamContext);
  const promptStats = params.capturePromptStats
    ? (params.measurePromptStats ?? streamContextModelPromptStats)(params.streamContext)
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
      const bytes = params.captureByteStats ? jsonLength(payload, true) : undefined;
      if (bytes !== undefined) {
        state.requestPayloadBytes = bytes;
      }
    },
    observeResponseChunk(startedAt: number, chunk: unknown) {
      observeModelResponse(state, startedAt, chunk, "chunk", params.captureByteStats);
    },
    observeFinalResult(eventBase: ModelCallEventBase, startedAt: number, result: unknown) {
      observeModelResponse(state, startedAt, result, "result", params.captureByteStats);
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
