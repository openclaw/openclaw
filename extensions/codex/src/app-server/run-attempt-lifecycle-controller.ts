import { createAgentHarnessAttemptLifecycle } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  embeddedAgentLog,
  FAST_MODE_AUTO_PROGRESS_KIND,
  formatErrorMessage,
  formatFastModeAutoProgressText,
  resolveAgentRunAbortLifecycleFields,
  resolveFastModeForElapsed,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS } from "./attempt-timeouts.js";
import {
  resolveTerminalDynamicToolBatchAction,
  shouldReleaseTurnAfterTerminalDynamicTool,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { itemName } from "./event-projector-items.js";
import type { CodexDynamicToolCallParams, CodexServerNotification } from "./protocol.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexServerRequestAdmission } from "./run-attempt-server-request-admission.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export function createCodexAttemptLifecycleController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
) {
  const { prompt, trajectoryRecorder } = resources;
  const { connection } = prompt.context.runtime;
  const {
    params,
    attemptStartedAt,
    runAbortController,
    fastModeAutoStartedAtMs,
    fastModeAutoProgressState,
  } = connection;
  const { state, activeTurnItemIds, pendingOpenClawDynamicToolCompletionIds } = turnRuntime;
  type TerminalToolRelease = NonNullable<typeof state.pendingTerminalDynamicToolRelease>;
  // A captured tool-authored final reply completes its batch: ordinary sibling results
  // still settle, but they cannot reopen the turn for another model step.
  const batchHadNonTerminalResult = () =>
    state.currentTurnHadNonTerminalDynamicToolResult && !state.currentTurnHadToolAuthoredFinalReply;
  const commitFinalSourceReplyDelivery = (value: {
    call: CodexDynamicToolCallParams;
    durationMs: number;
    requestAdmission?: CodexServerRequestAdmission;
  }) => {
    if (state.finalSourceReplyCommit) {
      return;
    }
    const committedAtMs = Date.now();
    state.finalSourceReplyCommit = { call: value.call, committedAtMs };
    turnRuntime.serverRequestAdmission.seal(value.requestAdmission);
    state.pendingTerminalDynamicToolRelease = undefined;
    state.currentTurnHadNonTerminalDynamicToolResult = false;
    state.currentTurnHadToolAuthoredFinalReply = false;
    turnRuntime.steeringQueueRef.current?.sealAdmission();
    // Final delivery ends execution ownership even while native Codex gets a
    // bounded opportunity to publish its clean turn/completed receipt.
    turnRuntime.deadlines.beginSettlement(committedAtMs);
    turnRuntime.armTerminalReleaseDeadline(
      committedAtMs + CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
      () => interruptTurnForTerminalRelease("completion_deadline"),
    );
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      name: value.call.tool,
      durationMs: value.durationMs,
      committedAtMs,
      mode: "await_turn_completed",
    });
    embeddedAgentLog.info(
      "codex app-server turn awaiting natural completion after final source reply",
      {
        threadId: value.call.threadId,
        turnId: value.call.turnId,
        toolCallId: value.call.callId,
        tool: value.call.tool,
        durationMs: value.durationMs,
      },
    );
  };
  const commitFinalSourceReply = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolRuntimeResponse;
    durationMs: number;
    requestAdmission?: CodexServerRequestAdmission;
  }) => {
    if (value.response.success && value.response.finalCurrentSourceReply === true) {
      commitFinalSourceReplyDelivery(value);
    }
  };
  const releaseTurnAfterTerminalDynamicTool = (value: TerminalToolRelease) => {
    if (state.finalSourceReplyCommit) {
      state.pendingTerminalDynamicToolRelease = undefined;
      state.currentTurnHadNonTerminalDynamicToolResult = false;
      state.currentTurnHadToolAuthoredFinalReply = false;
      return;
    }
    if (
      !shouldReleaseTurnAfterTerminalDynamicTool({
        completed: state.completed,
        aborted: runAbortController.signal.aborted,
        responseSuccess: value.response.success,
        currentTurnHadNonTerminalDynamicToolResult: batchHadNonTerminalResult(),
        activeAppServerTurnRequests: state.activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
      })
    ) {
      return;
    }
    state.pendingTerminalDynamicToolRelease = undefined;
    state.currentTurnHadToolAuthoredFinalReply = false;
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      name: value.call.tool,
      durationMs: value.durationMs,
      mode: "interrupt_and_complete_locally",
    });
    embeddedAgentLog.info("codex app-server turn released after terminal dynamic tool result", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      tool: value.call.tool,
      durationMs: value.durationMs,
    });
    // Interrupt drops accepted pending input. Reject unconsumed steering first so
    // completion delivery can use its fallback path instead of reporting success.
    turnRuntime.steeringQueueRef.current?.cancel();
    void turnRuntime.interruptTurn(value.call.turnId, { locallyCompleted: true });
    turnRuntime.completeTurn();
  };
  const interruptTurnForTerminalRelease = (
    cause: "completion_deadline" | "new_inbound_message",
  ) => {
    const pending = state.finalSourceReplyCommit?.call;
    if (
      !pending ||
      state.localCompletionRequested ||
      state.completed ||
      state.terminalTurnNotificationQueued ||
      runAbortController.signal.aborted
    ) {
      return;
    }
    turnRuntime.clearTerminalReleaseDeadline();
    trajectoryRecorder?.recordEvent("turn.terminal_release_interrupt", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      toolCallId: pending.callId,
      name: pending.tool,
      cause,
      deadlineMs: CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
    });
    embeddedAgentLog.warn("codex app-server final source reply grace expired; interrupting", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      toolCallId: pending.callId,
      tool: pending.tool,
      cause,
    });
    turnRuntime.steeringQueueRef.current?.cancel();
    void (async () => {
      try {
        // interruptTurn sets localCompletionRequested synchronously before its
        // first await, fencing concurrent deadline/inbound release attempts.
        await turnRuntime.interruptTurn(pending.turnId, { locallyCompleted: true });
      } catch (error) {
        embeddedAgentLog.warn("codex app-server terminal-release interrupt failed", {
          threadId: pending.threadId,
          turnId: pending.turnId,
          toolCallId: pending.callId,
          error: formatErrorMessage(error),
        });
      } finally {
        // The source reply is already delivered. Cleanup failure must not wedge
        // the local attempt or demote that committed result.
        turnRuntime.completeTurn();
      }
    })();
  };
  const scheduleTerminalDynamicToolReleaseCheck = () => {
    if (
      state.terminalDynamicToolReleaseCheckScheduled ||
      (!state.pendingTerminalDynamicToolRelease &&
        !state.currentTurnHadNonTerminalDynamicToolResult)
    ) {
      return;
    }
    // The JSON-RPC response must flush before the terminal tool interrupts its turn.
    state.terminalDynamicToolReleaseCheckScheduled = true;
    const immediate = setImmediate(() => {
      state.terminalDynamicToolReleaseCheckScheduled = false;
      if (state.finalSourceReplyCommit) {
        state.pendingTerminalDynamicToolRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
        state.currentTurnHadToolAuthoredFinalReply = false;
        return;
      }
      if (
        state.pendingTerminalDynamicToolRelease?.response.success === true &&
        !batchHadNonTerminalResult() &&
        state.activeAppServerTurnRequests === 0 &&
        pendingOpenClawDynamicToolCompletionIds.size === 0
      ) {
        // Tool response flush plus sibling classification commits terminal release.
        // Fence steering now; active Codex items may delay the actual interrupt.
        turnRuntime.steeringQueueRef.current?.cancel();
      }
      const action = resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: state.activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
        currentTurnHadNonTerminalDynamicToolResult: batchHadNonTerminalResult(),
        hasPendingTerminalDynamicToolRelease: state.pendingTerminalDynamicToolRelease !== undefined,
      });
      if (action === "release-pending-terminal" && state.pendingTerminalDynamicToolRelease) {
        releaseTurnAfterTerminalDynamicTool(state.pendingTerminalDynamicToolRelease);
      } else if (action === "clear-nonterminal-batch") {
        state.pendingTerminalDynamicToolRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
        state.currentTurnHadToolAuthoredFinalReply = false;
      }
    });
    immediate.unref?.();
  };
  const scheduleTurnReleaseAfterTerminalDynamicTool = (value: TerminalToolRelease) => {
    state.pendingTerminalDynamicToolRelease = value;
    scheduleTerminalDynamicToolReleaseCheck();
  };
  /** Classifies one settled dynamic tool result into the current batch's release state. */
  const recordDynamicToolResult = (value: TerminalToolRelease) => {
    if (value.response.success && value.response.toolAuthoredFinalReply === true) {
      state.currentTurnHadToolAuthoredFinalReply = true;
    }
    if (value.response.terminate === true && value.response.success) {
      scheduleTurnReleaseAfterTerminalDynamicTool(value);
    } else if (value.response.asyncStarted === true) {
      scheduleTerminalDynamicToolReleaseCheck();
    } else {
      state.currentTurnHadNonTerminalDynamicToolResult = true;
      if (!state.currentTurnHadToolAuthoredFinalReply) {
        state.pendingTerminalDynamicToolRelease = undefined;
      }
    }
  };
  const { emitLifecycleStart, emitLifecycleTerminal, emitExecutionPhaseOnce } =
    createAgentHarnessAttemptLifecycle({
      attempt: params,
      backend: "codex-app-server",
      startedAtMs: attemptStartedAt,
      state,
      emitEvent: (event) => emitCodexAppServerEvent(params, event),
      shouldSuppressTerminal: () =>
        Boolean(state.permissionChangeRestart || params.pluginRuntimeRefreshPending?.()),
    });
  const buildLifecycleTerminalMeta = (input: {
    aborted: boolean;
    timedOut: boolean;
    yielded?: boolean;
  }) => {
    const abortFields = input.aborted
      ? resolveAgentRunAbortLifecycleFields(runAbortController.signal)
      : undefined;
    return buildCodexLifecycleTerminalMeta({
      ...input,
      abortStopReason: abortFields?.stopReason,
    });
  };
  const reportExecutionNotification = (notification: CodexServerNotification) => {
    if (notification.method === "turn/started") {
      emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      emitExecutionPhaseOnce("assistant_output_started", { phase: "assistant_output_started" });
      return;
    }
    if (notification.method !== "item/started") {
      return;
    }
    const item = readCodexNotificationItem(notification.params);
    const tool = item ? itemName(item) : undefined;
    if (item && tool) {
      emitExecutionPhaseOnce(`tool:${item.id}`, {
        phase: "tool_execution_started",
        tool,
        itemId: item.id,
      });
    }
  };
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }) => {
    const summary = formatFastModeAutoProgressText(payload);
    await emitCodexAppServerEvent(params, {
      stream: "item",
      data: { kind: "status", title: "Fast", phase: "update", summary },
    });
    try {
      await params.onToolResult?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch (error) {
      embeddedAgentLog.debug("codex app-server fast mode auto progress delivery failed", { error });
    }
  };
  const maybeAnnounceFastModeAutoOff = async () => {
    if (
      params.fastModeAuto !== true ||
      fastModeAutoStartedAtMs === undefined ||
      fastModeAutoProgressState.offAnnounced
    ) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeAutoStartedAtMs,
      fastAutoOnSeconds: params.fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  const maybeEmitFastModeAutoResetBestEffort = async () => {
    try {
      if (
        params.fastModeAuto !== true ||
        !fastModeAutoProgressState.offAnnounced ||
        fastModeAutoProgressState.resetAnnounced
      ) {
        return;
      }
      fastModeAutoProgressState.resetAnnounced = true;
      await emitFastModeAutoProgress({
        enabled: true,
        elapsedSeconds: 0,
        fastAutoOnSeconds: params.fastModeAutoOnSeconds,
      });
    } catch (error) {
      embeddedAgentLog.warn(
        `codex app-server fast mode auto reset progress failed: ${formatErrorMessage(error)}`,
      );
    }
  };
  return {
    recordDynamicToolResult,
    commitFinalSourceReplyDelivery,
    commitFinalSourceReply,
    scheduleTerminalDynamicToolReleaseCheck,
    scheduleTurnReleaseAfterTerminalDynamicTool,
    interruptTurnForTerminalRelease,
    emitLifecycleStart,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
    emitExecutionPhaseOnce,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
    maybeEmitFastModeAutoResetBestEffort,
  };
}

export type CodexAttemptLifecycleController = ReturnType<
  typeof createCodexAttemptLifecycleController
>;
