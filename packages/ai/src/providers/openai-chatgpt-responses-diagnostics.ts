import { getAiTransportHost } from "../host.js";
import { ResponsesStreamFailure } from "../transports/openai-responses-debug.js";
import type { ResponsesEncryptedContentAttempt } from "../transports/openai-responses-replay-internal.js";
import { CodexApiError } from "./openai-chatgpt-responses-events.js";
import type { RequestBody } from "./openai-chatgpt-responses-websocket-state.js";

export type CodexRequestDispatch = {
  request: RequestBody;
  actualTransport: "websocket" | "sse";
  payloadVariant: ResponsesEncryptedContentAttempt<RequestBody>["kind"];
};

// Fixed fields and counts only: never copy item types, IDs, or content into logs.
export function summarizeCodexRequestDispatch(dispatch: CodexRequestDispatch | undefined) {
  if (!dispatch) {
    return { requestDispatched: false };
  }
  const { request, actualTransport, payloadVariant } = dispatch;
  const input = request.input ?? [];
  return {
    requestDispatched: true,
    actualTransport,
    payloadVariant,
    hasPreviousResponseId: Boolean(request.previous_response_id),
    inputItems: input.length,
    reasoningItems: input.filter((item) => item.type === "reasoning").length,
    compactionItems: input.filter((item) => item.type === "compaction").length,
    toolCallItems: input.filter((item) => item.type === "function_call").length,
    toolResultItems: input.filter((item) => item.type === "function_call_output").length,
  };
}

export function logCodexRequestFailure(
  dispatch: CodexRequestDispatch | undefined,
  eventsEmitted: boolean,
  recoveryAction: CodexRequestDispatch["payloadVariant"] | "full-input-reconnect" | "propagate",
): void {
  getAiTransportHost().logWarn("openai-transport", "ChatGPT Responses request rejected", {
    ...summarizeCodexRequestDispatch(dispatch),
    eventsEmitted,
    recoveryAction,
  });
}

type StreamFailureKind = "timeout" | "caller-abort" | "provider-failure" | "transport";

/** Local-only failure category for transport diagnostics; never provider text. */
export function classifyStreamFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  requestTimedOut: boolean,
): StreamFailureKind {
  if (requestTimedOut) {
    return "timeout";
  }
  if (signal?.aborted) {
    return "caller-abort";
  }
  // CodexApiError carries a non-OK HTTP reply; both are provider decisions, not transport faults.
  return error instanceof ResponsesStreamFailure || error instanceof CodexApiError
    ? "provider-failure"
    : "transport";
}

export function isRequestTimeoutError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): boolean {
  if (timeoutMs === undefined || callerSignal?.aborted || !requestSignal?.aborted) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message === "Request was aborted"
  );
}
