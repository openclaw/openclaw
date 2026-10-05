import {
  embeddedAgentLog,
  formatToolExecutionErrorMessage,
  normalizeQuestionTimeoutSeconds,
  resolveToolExecutionErrorKind,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  copyInternalToolResultState,
  runWithAsyncWorkResources,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import {
  addSafeTimeoutDelayGraceMs,
  addTimerTimeoutGraceMs,
} from "openclaw/plugin-sdk/number-runtime";
import { TURN_FINALIZE_DRAIN_ABORT_GRACE_MS } from "./attempt-timeouts.js";
import {
  createCommittedFinalSourceReplyResponse,
  createFailedDynamicToolResponse,
  failedToolResult,
  readDynamicToolResponseText,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import { canProduceFinalSourceReplyDelivery } from "./dynamic-tool-source-reply.js";
import { formatDynamicToolTimeoutDetails } from "./dynamic-tool-timeout-details.js";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolDiagnosticTerminalReason,
  type JsonValue,
} from "./protocol.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
// timeoutSeconds is an inner tool budget. Keep enough outer-watchdog headroom
// for bounded setup RPCs and the tool's structured timeout result to complete.
const CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS = 30_000;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 120_000;
const CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS = 30_000;
const CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS = 30_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = 600_000;
/** Outer default for collector waits: full swarm budget plus completion grace. */
const CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS =
  CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS;

/**
 * Runs a dynamic tool call with run-abort and the budget prepared by
 * resolveDynamicToolCallTimeoutMs, preserving tool-specific completion grace.
 */
type DynamicToolCallExecutionParams = {
  call: CodexDynamicToolCallParams;
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall" | "consumeToolExecutionSnapshot"> &
    Partial<Pick<CodexDynamicToolBridge, "sideEffectOwnerKeyForTool">>;
  signal: AbortSignal;
  timeoutMs: number;
  toolMeta?: string;
  toolCallOrdinal?: number;
  onAgentToolResult?: EmbeddedRunAttemptParams["onAgentToolResult"];
  onFallbackSelected?: () => void;
  onTimeout?: () => void;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
  onFinalSourceReplyDelivery?: () => void;
};

export async function handleDynamicToolCallWithTimeout(
  params: DynamicToolCallExecutionParams,
): Promise<CodexDynamicToolRuntimeResponse> {
  return await runWithAsyncWorkResources((onAcquired) =>
    executeDynamicToolCallWithTimeout(params, (release) =>
      onAcquired({ release, releaseBeforeResultWhenIdle: true }),
    ),
  );
}

async function executeDynamicToolCallWithTimeout(
  params: DynamicToolCallExecutionParams,
  retainCleanup: (release: () => void) => void,
): Promise<CodexDynamicToolRuntimeResponse> {
  // Timeout or run abort can win while a tool ignores cancellation. Keep the
  // private observer terminal result exactly once across those competing paths.
  let didNotifyAgentToolResult = false;
  let finalSourceReplyDelivered = false;
  let acceptFinalSourceReplyDelivery = true;
  let resolveFinalSourceReplyDelivery!: () => void;
  const finalSourceReplyDelivery = new Promise<void>((resolve) => {
    resolveFinalSourceReplyDelivery = resolve;
  });
  const shouldReconcileFinalSourceReply =
    params.onFinalSourceReplyDelivery !== undefined &&
    canProduceFinalSourceReplyDelivery(params.call);
  const conservativeRaceResponses = new WeakSet<CodexDynamicToolRuntimeResponse>();
  const finalizeTerminal = (response: CodexDynamicToolRuntimeResponse) => {
    const executionSnapshot = params.toolBridge.consumeToolExecutionSnapshot?.(params.call.callId);
    const ownerKey = params.toolBridge.sideEffectOwnerKeyForTool?.(params.call.tool);
    const settledResponse =
      !response.success && finalSourceReplyDelivered
        ? createCommittedFinalSourceReplyResponse({
            executedArguments:
              response.executedArguments ??
              executionSnapshot?.executedArguments ??
              (isJsonObject(params.call.arguments) ? params.call.arguments : {}),
          })
        : response;
    if (settledResponse.success && finalSourceReplyDelivered && !didNotifyAgentToolResult) {
      notifyAgentToolResult({
        toolName: params.call.tool,
        result: {
          content: [{ type: "text", text: "Source reply delivered." }],
          details: { status: "success", sourceReplyDelivered: true },
        },
        isError: false,
      });
    }
    // The host observer owns active wrapper state. A bridge snapshot is only needed
    // after that wrapper settles while result post-processing remains pending.
    const observedExecutionStarted =
      executionSnapshot?.executionStarted ??
      (conservativeRaceResponses.has(settledResponse)
        ? undefined
        : settledResponse.executionStarted);
    const terminalResolution = params.observeToolTerminal?.({
      toolCallId: params.call.callId,
      toolName: params.call.tool,
      result: copyInternalToolResultState(settledResponse, {
        ...settledResponse,
        details: settledResponse.transcriptDetails,
      }),
      arguments:
        settledResponse.executedArguments ??
        executionSnapshot?.executedArguments ??
        params.call.arguments,
      ...(params.toolMeta ? { meta: params.toolMeta } : {}),
      ...(ownerKey ? { ownerMutation: { ownerKey } } : {}),
      replaySafe: ownerKey ? false : response.replaySafe,
      ...(observedExecutionStarted !== undefined
        ? { executionStarted: observedExecutionStarted }
        : {}),
      outcome: settledResponse.success ? "success" : "failure",
      ...(!settledResponse.success
        ? { failure: { error: readDynamicToolResponseText(settledResponse) } }
        : {}),
    });
    if (terminalResolution) {
      settledResponse.terminalResolution = terminalResolution;
      settledResponse.executionStarted = terminalResolution.executionStarted;
      settledResponse.executedArguments =
        terminalResolution.executedArguments ?? settledResponse.executedArguments;
      settledResponse.sideEffectEvidence = terminalResolution.sideEffectEvidence || undefined;
    }
    return settledResponse;
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
  let resolveAbort: ((response: CodexDynamicToolRuntimeResponse) => void) | undefined;
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
    if (!finalSourceReplyDelivered && !shouldReconcileFinalSourceReply) {
      notifyFailedToolResult(message, terminalReason);
    }
    resolveAbort?.(createFailedAfterPossibleDispatch(message, terminalReason));
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
  retainCleanup(releaseOperation);
  const abortPromise = new Promise<CodexDynamicToolRuntimeResponse>((resolve) => {
    resolveAbort = resolve;
  });
  const timeoutPromise = new Promise<CodexDynamicToolRuntimeResponse>((resolve) => {
    const { timeoutMs } = params;
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
      if (!finalSourceReplyDelivered && !shouldReconcileFinalSourceReply) {
        notifyFailedToolResult(timeoutDetails.responseMessage, "timed_out");
      }
      resolve(createFailedAfterPossibleDispatch(timeoutDetails.responseMessage, "timed_out"));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    params.signal.addEventListener("abort", abortFromRun, { once: true });
    if (params.signal.aborted) {
      abortFromRun();
    }
    const toolCall = params.toolBridge.handleToolCall(params.call, {
      signal: controller.signal,
      onAgentToolResult: (event) => {
        // A final-source transport can report cancellation before its delivery
        // receipt settles. Hold that provisional failure through the bounded
        // reconciliation window so observers receive one canonical outcome.
        if (event.isError && shouldReconcileFinalSourceReply) {
          return;
        }
        notifyAgentToolResult(event);
      },
      toolCallOrdinal: params.toolCallOrdinal,
      retainExecutionSnapshot: true,
      onFinalSourceReplyDelivery: () => {
        if (!acceptFinalSourceReplyDelivery) {
          return;
        }
        finalSourceReplyDelivered = true;
        resolveFinalSourceReplyDelivery();
        params.onFinalSourceReplyDelivery?.();
      },
    });
    const toolCallOutcome = toolCall.then(
      (response) => ({ kind: "tool" as const, response }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const initialOutcome = await Promise.race([
      toolCallOutcome,
      abortPromise.then((response) => ({ kind: "fallback" as const, response })),
      timeoutPromise.then((response) => ({ kind: "fallback" as const, response })),
    ]);
    const fallbackTriggered = timedOut || params.signal.aborted;
    if (
      initialOutcome.kind === "error" &&
      !(shouldReconcileFinalSourceReply && fallbackTriggered)
    ) {
      throw initialOutcome.error;
    }
    let response =
      initialOutcome.kind === "error"
        ? createFailedAfterPossibleDispatch(
            formatToolExecutionErrorMessage(
              initialOutcome.error,
              "OpenClaw dynamic tool call failed.",
            ),
            params.signal.aborted
              ? resolveCodexToolAbortTerminalReason(params.signal)
              : timedOut
                ? "timed_out"
                : "failed",
          )
        : initialOutcome.response;
    if (
      shouldReconcileFinalSourceReply &&
      fallbackTriggered &&
      !(response.success && response.finalCurrentSourceReply === true) &&
      !finalSourceReplyDelivered
    ) {
      // A transport may finish just after its cancellation signal. Keep the
      // existing finalization grace as the bounded authority window so a raw
      // delivery receipt wins before failure is published to either observer.
      let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
      const confirmedFinalToolOutcome = new Promise<{
        kind: "tool";
        response: CodexDynamicToolRuntimeResponse;
      }>((resolve) => {
        void toolCallOutcome.then((outcome) => {
          if (
            outcome.kind === "tool" &&
            outcome.response.success &&
            outcome.response.finalCurrentSourceReply === true
          ) {
            resolve(outcome);
          }
        });
      });
      const reconciliation = await Promise.race([
        finalSourceReplyDelivery.then(() => ({ kind: "delivery" as const })),
        confirmedFinalToolOutcome,
        new Promise<{ kind: "grace" }>((resolve) => {
          reconciliationTimer = setTimeout(
            () => resolve({ kind: "grace" }),
            TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
          );
          reconciliationTimer.unref?.();
        }),
      ]);
      if (reconciliationTimer) {
        clearTimeout(reconciliationTimer);
      }
      if (
        reconciliation.kind === "tool" &&
        reconciliation.response.success &&
        reconciliation.response.finalCurrentSourceReply === true
      ) {
        response = reconciliation.response;
      }
    }
    if (!response.success && !didNotifyAgentToolResult && !finalSourceReplyDelivered) {
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
    if (!finalSourceReplyDelivered) {
      notifyFailedToolResult(message, terminalReason);
    }
    return finalizeTerminal(createFailedAfterPossibleDispatch(message, terminalReason));
  } finally {
    acceptFinalSourceReplyDelivery = false;
    if (timeout) {
      clearTimeout(timeout);
    }
    toolCallSettled = true;
    resolveAbort = undefined;
    if (!completedSuccessfully || timedOut || controller.signal.aborted) {
      // Failure/cancellation does not retain an operation merely because its
      // accepted continuation has not observed the authority failure yet.
      releaseOperation();
    }
  }
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

/** Adds async-started progress details when a tool result continues out of band. */
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

type TerminalDynamicToolReleaseState = {
  completed: boolean;
  aborted: boolean;
  responseSuccess: boolean;
  currentTurnHadNonTerminalDynamicToolResult: boolean;
  activeAppServerTurnRequests: number;
  activeTurnItemIdsCount: number;
  pendingOpenClawDynamicToolCompletionIdsCount: number;
};

export function shouldReleaseTurnAfterTerminalDynamicTool(
  state: TerminalDynamicToolReleaseState,
): boolean {
  return (
    !state.completed &&
    !state.aborted &&
    state.responseSuccess &&
    !state.currentTurnHadNonTerminalDynamicToolResult &&
    state.activeAppServerTurnRequests === 0 &&
    state.activeTurnItemIdsCount === 0 &&
    state.pendingOpenClawDynamicToolCompletionIdsCount === 0
  );
}

type TerminalDynamicToolBatchAction =
  | "idle"
  | "wait"
  | "clear-nonterminal-batch"
  | "release-pending-terminal";

type TerminalDynamicToolBatchState = {
  activeAppServerTurnRequests: number;
  activeTurnItemIdsCount: number;
  pendingOpenClawDynamicToolCompletionIdsCount: number;
  currentTurnHadNonTerminalDynamicToolResult: boolean;
  hasPendingTerminalDynamicToolRelease: boolean;
};

export function resolveTerminalDynamicToolBatchAction(
  state: TerminalDynamicToolBatchState,
): TerminalDynamicToolBatchAction {
  if (
    state.activeAppServerTurnRequests > 0 ||
    state.activeTurnItemIdsCount > 0 ||
    state.pendingOpenClawDynamicToolCompletionIdsCount > 0
  ) {
    return "wait";
  }
  if (state.currentTurnHadNonTerminalDynamicToolResult) {
    return "clear-nonterminal-batch";
  }
  if (state.hasPendingTerminalDynamicToolRelease) {
    return "release-pending-terminal";
  }
  return "idle";
}

export function resolveDynamicToolCallTimeoutMs(params: {
  call: CodexDynamicToolCallParams;
  config: EmbeddedRunAttemptParams["config"];
  toolBridge?: Pick<CodexDynamicToolBridge, "availableTools">;
}): number {
  const args = isJsonObject(params.call.arguments) ? params.call.arguments : undefined;
  if (params.call.tool === "node_exec") {
    const executionTimeoutMs = params.toolBridge?.availableTools
      .find((tool) => tool.name === params.call.tool)
      ?.getExecutionTimeoutMs?.(params.call.arguments);
    if (executionTimeoutMs !== undefined) {
      // Foreground node execution owns its command and transport budgets.
      return addSafeTimeoutDelayGraceMs(
        executionTimeoutMs,
        CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS,
      );
    }
  }
  if (
    params.call.tool === "openclaw" ||
    params.call.tool === "ask_user" ||
    (params.call.tool === "secrets" && args?.action === "request")
  ) {
    try {
      // Human entry owns a validated wait longer than ordinary tool execution.
      // OpenClaw delegation uses that default for its ten-minute approval plus
      // staging/application; it has no model-authored timeout override.
      const timeoutSeconds = params.call.tool === "openclaw" ? undefined : args?.timeoutSeconds;
      return (
        normalizeQuestionTimeoutSeconds(timeoutSeconds) * 1_000 +
        CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS
      );
    } catch {
      // Invalid input still reaches the tool's validation under the ordinary watchdog.
      return CODEX_DYNAMIC_TOOL_TIMEOUT_MS;
    }
  }
  if (params.call.tool === "computer") {
    return clampDynamicToolTimeoutMs(readComputerToolTimeoutMs(params.call.arguments));
  }
  // The message tool's `timeoutMs` is a Gateway transport budget. Its outer
  // watchdog must also cover bounded same-key reconciliation after that timer.
  if (params.call.tool === "message") {
    return CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS;
  }
  // Collector waits need the full swarm budget plus grace for their structured timeout.
  const isCollectorWait = params.call.tool === "agents_wait";
  return clampDynamicToolTimeoutMs(
    readDynamicToolCallTimeoutMs(params.call.arguments) ??
      readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ??
      (isCollectorWait ? CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS : CODEX_DYNAMIC_TOOL_TIMEOUT_MS),
    isCollectorWait ? CODEX_DYNAMIC_AGENTS_WAIT_TOOL_TIMEOUT_MS : CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
  );
}

/** Transport guard stays outside the handler's bounded tool wait and completion grace. */
export function resolveDynamicToolServerRequestTimeoutMs(
  call?: CodexDynamicToolCallParams,
): number {
  return (
    Math.max(
      CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS,
      call ? resolveDynamicToolCallTimeoutMs({ call, config: undefined }) : 0,
    ) + CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS
  );
}

function readComputerToolTimeoutMs(value: JsonValue | undefined): number {
  const args = isJsonObject(value) ? value : undefined;
  const action = typeof args?.action === "string" ? args.action : undefined;
  const gatewayTimeoutMs =
    readPositiveFiniteTimeoutMs(args?.timeoutMs) ?? CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS;
  // Node discovery can make two calls when it falls back from node.list to the
  // legacy pairing list. Screenshot/wait then capture once; input also acts.
  const gatewayCallCount = action === "screenshot" || action === "wait" ? 3 : 4;
  const durationMs =
    action === "wait" || action === "hold_key"
      ? Math.max(0, Number(args?.duration) || 0) * 1000
      : 0;
  // `timeoutMs` is a per-Gateway-call transport budget, not the whole dynamic
  // tool deadline. Computer use can resolve a node, perform/wait, then capture.
  return (
    durationMs + gatewayCallCount * gatewayTimeoutMs + CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS
  );
}

function readDynamicToolCallTimeoutMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const timeoutMs = readPositiveFiniteTimeoutMs(value.timeoutMs);
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSecondsMs = readDynamicToolTimeoutSecondsAsMs(value.timeoutSeconds);
  return timeoutSecondsMs === undefined
    ? undefined
    : addTimerTimeoutGraceMs(timeoutSecondsMs, CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS);
}

function readConfiguredDynamicToolTimeoutMs(
  toolName: string,
  config: EmbeddedRunAttemptParams["config"],
): number | undefined {
  if (toolName === "image_generate") {
    const imageModel = config?.agents?.defaults?.mediaModels?.image;
    if (!imageModel || typeof imageModel !== "object") {
      return CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
    }
    return (
      readPositiveFiniteTimeoutMs(imageModel.timeoutMs) ??
      CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS
    );
  }

  if (toolName === "view_image") {
    const candidates = (config?.tools?.media?.models ?? []).filter(
      (entry) => !entry.capabilities || entry.capabilities.includes("image"),
    );
    const capabilityTimeoutMs = readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds);
    return Math.max(
      capabilityTimeoutMs ?? CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
      ...candidates.map(
        (entry) =>
          readTimeoutSecondsAsMs(entry.timeoutSeconds) ??
          capabilityTimeoutMs ??
          CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
      ),
    );
  }

  return undefined;
}

function readTimeoutSecondsAsMs(value: unknown): number | undefined {
  const seconds = readPositiveFiniteTimeoutMs(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function readDynamicToolTimeoutSecondsAsMs(value: unknown): number | undefined {
  // Model-facing timeoutSeconds schemas use integers. Reject malformed
  // fractions instead of silently shortening the caller's budget.
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return undefined;
  }
  return value * 1000;
}

function readPositiveFiniteTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clampDynamicToolTimeoutMs(
  timeoutMs: number,
  maximum = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
): number {
  return Math.max(1, Math.min(maximum, Math.floor(timeoutMs)));
}
