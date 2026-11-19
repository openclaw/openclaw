import {
  embeddedAgentLog,
  formatToolExecutionErrorMessage,
  resolveToolExecutionErrorKind,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  copyInternalToolResultState,
  runWithAsyncWorkResources,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";
import {
  createFailedDynamicToolResponse,
  failedToolResult,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolDiagnosticTerminalReason,
} from "./protocol.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

const LOG_FIELD_MAX_LENGTH = 160;

type DynamicToolTimeoutDetails = {
  responseMessage: string;
  consoleMessage: string;
  meta: Record<string, unknown>;
};

function normalizeLogField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replaceAll(String.fromCharCode(27), " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return truncateWithMarker(normalized, LOG_FIELD_MAX_LENGTH, {
    marker: "...",
    reserve: 3,
    trimEnd: false,
  });
}

function readNumericTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = parseStrictNonNegativeInteger(value);
    return parsed === undefined ? undefined : Math.max(0, parsed);
  }
  return undefined;
}

function formatDynamicToolTimeoutDetails(params: {
  call: CodexDynamicToolCallParams;
  timeoutMs: number;
}): DynamicToolTimeoutDetails {
  const tool = normalizeLogField(params.call.tool) ?? "unknown";
  const baseMeta: Record<string, unknown> = {
    tool: params.call.tool,
    toolCallId: params.call.callId,
    threadId: params.call.threadId,
    turnId: params.call.turnId,
    timeoutMs: params.timeoutMs,
    timeoutKind: "codex_dynamic_tool_rpc",
  };

  if (tool !== "process" || !isJsonObject(params.call.arguments)) {
    return {
      responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms while running tool ${tool}.`,
      consoleMessage: `codex dynamic tool timeout: tool=${tool} toolTimeoutMs=${params.timeoutMs}; per-tool-call watchdog, not session idle`,
      meta: baseMeta,
    };
  }

  const action = normalizeLogField(params.call.arguments.action);
  const sessionId = normalizeLogField(params.call.arguments.sessionId);
  const requestedTimeoutMs = readNumericTimeoutMs(params.call.arguments.timeout);
  const actionPart = action ? ` action=${action}` : "";
  const sessionPart = sessionId ? ` sessionId=${sessionId}` : "";
  const requestedPart =
    requestedTimeoutMs === undefined ? "" : ` requestedWaitMs=${requestedTimeoutMs}`;
  const retryHint =
    action === "poll"
      ? "; repeated lines usually mean process-poll retry churn, not model progress"
      : "";
  const responseTarget =
    action || sessionId
      ? ` while waiting for process${actionPart}${sessionPart}`
      : " while waiting for the process tool";

  return {
    responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms${responseTarget}. This is a tool RPC timeout, not a session idle timeout.`,
    consoleMessage: `codex process tool timeout:${actionPart}${sessionPart} toolTimeoutMs=${params.timeoutMs}${requestedPart}; per-tool-call watchdog, not session idle${retryHint}`,
    meta: {
      ...baseMeta,
      processAction: action,
      processSessionId: sessionId,
      processRequestedTimeoutMs: requestedTimeoutMs,
    },
  };
}

/**
 * Runs a dynamic tool call with run-abort and the budget prepared by
 * resolveDynamicToolCallTimeoutMs, preserving tool-specific completion grace.
 */
type DynamicToolCallExecutionParams = {
  call: CodexDynamicToolCallParams;
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall" | "consumeToolExecutionSnapshot"> &
    Partial<Pick<CodexDynamicToolBridge, "sideEffectOwnerKeyForTool">>;
  signal: AbortSignal;
  /** Null retains an admitted unlimited parent wait, still subject to cancellation. */
  timeoutMs: number | null;
  toolMeta?: string;
  toolCallOrdinal?: number;
  onAgentToolResult?: EmbeddedRunAttemptParams["onAgentToolResult"];
  onFallbackSelected?: () => void;
  onTimeout?: () => void;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
};

export async function handleDynamicToolCallWithTimeout(
  params: DynamicToolCallExecutionParams,
): Promise<CodexDynamicToolRuntimeResponse> {
  return await runWithAsyncWorkResources(async (onAcquired) => {
    // Timeout or run abort can win while a tool ignores cancellation. Keep the
    // private observer terminal result exactly once across those competing paths.
    let didNotifyAgentToolResult = false;
    const conservativeRaceResponses = new WeakSet<CodexDynamicToolRuntimeResponse>();
    const finalizeTerminal = (response: CodexDynamicToolRuntimeResponse) => {
      const executionSnapshot = params.toolBridge.consumeToolExecutionSnapshot?.(
        params.call.callId,
      );
      const ownerKey = params.toolBridge.sideEffectOwnerKeyForTool?.(params.call.tool);
      // The host observer owns active wrapper state. A bridge snapshot is only needed
      // after that wrapper settles while result post-processing remains pending.
      const observedExecutionStarted =
        executionSnapshot?.executionStarted ??
        (conservativeRaceResponses.has(response) ? undefined : response.executionStarted);
      const terminalResolution = params.observeToolTerminal?.({
        toolCallId: params.call.callId,
        toolName: params.call.tool,
        result: copyInternalToolResultState(response, {
          ...response,
          details: response.transcriptDetails,
        }),
        arguments:
          response.executedArguments ??
          executionSnapshot?.executedArguments ??
          params.call.arguments,
        ...(params.toolMeta ? { meta: params.toolMeta } : {}),
        ...(ownerKey ? { ownerMutation: { ownerKey } } : {}),
        replaySafe: ownerKey ? false : response.replaySafe,
        ...(observedExecutionStarted !== undefined
          ? { executionStarted: observedExecutionStarted }
          : {}),
        outcome: response.success ? "success" : "failure",
        ...(!response.success
          ? {
              failure: {
                error: readDynamicToolResponseText(response),
                ...(response.unknownTool ? { unknownTool: true as const } : {}),
              },
            }
          : {}),
      });
      if (terminalResolution) {
        response.terminalResolution = terminalResolution;
        response.executionStarted = terminalResolution.executionStarted;
        response.executedArguments =
          terminalResolution.executedArguments ?? response.executedArguments;
        response.sideEffectEvidence = terminalResolution.sideEffectEvidence || undefined;
      }
      return response;
    };
    // The host observer replaces these conservative facts with exact boundary evidence.
    // Direct/older callers without one must still treat a raced terminal as dispatched.
    const createFailedAfterPossibleDispatch = (
      message: string,
      terminalReason: CodexDynamicToolDiagnosticTerminalReason,
    ) => {
      const response = createFailedDynamicToolResponse(message, {
        executionStarted: true,
        sideEffectEvidence: true,
        terminalReason,
      });
      conservativeRaceResponses.add(response);
      return response;
    };
    const notifyAgentToolResult = (
      event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentToolResult"]>>[0],
    ) => {
      if (didNotifyAgentToolResult) {
        return;
      }
      didNotifyAgentToolResult = true;
      try {
        params.onAgentToolResult?.(event);
      } catch (error) {
        const message = formatToolExecutionErrorMessage(error, "Unknown error");
        embeddedAgentLog.warn(
          `onAgentToolResult handler failed: tool=${params.call.tool} error=${message}`,
        );
      }
    };
    const notifyFailedToolResult = (
      message: string,
      terminalReason: "failed" | "cancelled" | "timed_out" = "failed",
    ) => {
      notifyAgentToolResult({
        toolName: params.call.tool,
        result: failedToolResult(message, terminalReason),
        isError: true,
      });
    };
    if (params.signal.aborted) {
      const message = "OpenClaw dynamic tool call aborted before execution.";
      const terminalReason = resolveCodexToolAbortTerminalReason(params.signal);
      params.onFallbackSelected?.();
      notifyFailedToolResult(message, terminalReason);
      return finalizeTerminal(
        createFailedDynamicToolResponse(message, {
          executionStarted: false,
          terminalReason,
        }),
      );
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let toolCallSettled = false;
    let completedSuccessfully = false;
    let operationReleased = false;
    const cancellation = createDeferred<CodexDynamicToolRuntimeResponse>();
    const abortFromRun = () => {
      const message = "OpenClaw dynamic tool call aborted.";
      const terminalReason = resolveCodexToolAbortTerminalReason(params.signal);
      controller.abort(params.signal.reason ?? new Error(message));
      // Accepted queued admission can retain cancellation after the tool result;
      // cancellation must not publish a second outcome for that completed call.
      if (toolCallSettled) {
        return;
      }
      params.onFallbackSelected?.();
      notifyFailedToolResult(message, terminalReason);
      cancellation.resolve(createFailedAfterPossibleDispatch(message, terminalReason));
    };
    const releaseOperation = () => {
      if (operationReleased) {
        return;
      }
      operationReleased = true;
      params.signal.removeEventListener("abort", abortFromRun);
      if (!controller.signal.aborted) {
        controller.abort(new Error("OpenClaw dynamic tool call finished."));
      }
    };
    // The same signal stays live only through host-owned tracked admission work.
    // No permission is transferred: run/scope/expiry guards still revalidate it.
    onAcquired({ release: releaseOperation, releaseBeforeResultWhenIdle: true });
    const { timeoutMs } = params;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        const timeoutDetails = formatDynamicToolTimeoutDetails({ call: params.call, timeoutMs });
        params.onFallbackSelected?.();
        controller.abort(new Error(timeoutDetails.responseMessage));
        params.onTimeout?.();
        embeddedAgentLog.warn("codex dynamic tool call timed out", {
          ...timeoutDetails.meta,
          consoleMessage: timeoutDetails.consoleMessage,
        });
        notifyFailedToolResult(timeoutDetails.responseMessage, "timed_out");
        cancellation.resolve(
          createFailedAfterPossibleDispatch(timeoutDetails.responseMessage, "timed_out"),
        );
      }, timeoutMs);
      timeout.unref?.();
    }

    try {
      params.signal.addEventListener("abort", abortFromRun, { once: true });
      if (params.signal.aborted) {
        abortFromRun();
      }
      const response = await Promise.race([
        params.toolBridge.handleToolCall(params.call, {
          signal: controller.signal,
          onAgentToolResult: notifyAgentToolResult,
          toolCallOrdinal: params.toolCallOrdinal,
          retainExecutionSnapshot: true,
        }),
        cancellation.promise,
      ]);
      if (!response.success && !didNotifyAgentToolResult) {
        notifyFailedToolResult(
          readDynamicToolResponseText(response),
          response.diagnosticTerminalReason ?? "failed",
        );
      }
      const terminal = finalizeTerminal(response);
      completedSuccessfully = terminal.success;
      return terminal;
    } catch (error) {
      const terminalReason = params.signal.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : resolveToolExecutionErrorKind(error);
      const message = formatToolExecutionErrorMessage(error, "OpenClaw dynamic tool call failed.");
      notifyFailedToolResult(message, terminalReason);
      return finalizeTerminal(createFailedAfterPossibleDispatch(message, terminalReason));
    } finally {
      clearTimeout(timeout);
      toolCallSettled = true;
      if (!completedSuccessfully || timedOut || controller.signal.aborted) {
        // Failure/cancellation does not retain an operation merely because its
        // accepted continuation has not observed the authority failure yet.
        releaseOperation();
      }
    }
  });
}

function readDynamicToolResponseText(response: CodexDynamicToolCallResponse): string {
  const text = response.contentItems
    .flatMap((item) =>
      item.type === "inputText" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();
  return text || "OpenClaw dynamic tool call failed.";
}

/** Strips OpenClaw-only metadata before sending a dynamic tool response to Codex. */
export function toCodexDynamicToolProtocolResponse(
  response: CodexDynamicToolRuntimeResponse,
): CodexDynamicToolCallResponse {
  return {
    contentItems: response.contentItems,
    success: response.success,
  };
}

export function toCodexDynamicToolProgressResponse(
  response: CodexDynamicToolRuntimeResponse,
  protocolResponse: CodexDynamicToolCallResponse,
): CodexDynamicToolCallResponse & {
  details?: { async: true; status: "started" } | { mcpAppPreview: unknown };
} {
  const transcriptDetails = isJsonObject(response.transcriptDetails)
    ? response.transcriptDetails
    : undefined;
  const mcpAppPreview = isJsonObject(transcriptDetails?.mcpAppPreview)
    ? transcriptDetails.mcpAppPreview
    : undefined;
  if (response.asyncStarted !== true && !mcpAppPreview) {
    return protocolResponse;
  }
  return {
    ...protocolResponse,
    details:
      response.asyncStarted === true
        ? { ...(mcpAppPreview ? { mcpAppPreview } : {}), async: true, status: "started" }
        : { mcpAppPreview },
  };
}
