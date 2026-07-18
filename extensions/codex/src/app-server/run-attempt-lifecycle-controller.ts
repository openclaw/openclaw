import {
  embeddedAgentLog,
  FAST_MODE_AUTO_PROGRESS_KIND,
  formatErrorMessage,
  formatFastModeAutoProgressText,
  resolveAgentRunAbortLifecycleFields,
  resolveFastModeForElapsed,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  interruptCodexTurnBestEffort,
} from "./attempt-client-cleanup.js";
import { reportCodexExecutionNotification } from "./attempt-notification-state.js";
import { CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS } from "./attempt-timeouts.js";
import {
  resolveTerminalDynamicToolBatchAction,
  shouldReleaseTurnAfterTerminalDynamicTool,
} from "./dynamic-tool-execution.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  CodexServerNotification,
} from "./protocol.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export function createCodexAttemptLifecycleController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
) {
  const { prompt, state: resourceState, trajectoryRecorder } = resources;
  const { connection } = prompt.context.runtime;
  const {
    params,
    attemptStartedAt,
    runAbortController,
    fastModeAutoStartedAtMs,
    fastModeAutoProgressState,
  } = connection;
  const { state, activeTurnItemIds, pendingOpenClawDynamicToolCompletionIds, turnWatches } =
    turnRuntime;
  const releaseTurnAfterTerminalDynamicTool = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    if (
      !shouldReleaseTurnAfterTerminalDynamicTool({
        completed: state.completed,
        aborted: runAbortController.signal.aborted,
        responseSuccess: value.response.success,
        currentTurnHadNonTerminalDynamicToolResult:
          state.currentTurnHadNonTerminalDynamicToolResult,
        activeAppServerTurnRequests: state.activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
      })
    ) {
      return;
    }
    state.pendingTerminalDynamicToolRelease = undefined;
    if (state.terminalReleaseAwaitingTurnCompletion) {
      return;
    }
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      name: value.call.tool,
      durationMs: value.durationMs,
      mode: "await_turn_completed",
    });
    embeddedAgentLog.info(
      "codex app-server turn awaiting natural completion after terminal dynamic tool result",
      {
        threadId: value.call.threadId,
        turnId: value.call.turnId,
        toolCallId: value.call.callId,
        tool: value.call.tool,
        durationMs: value.durationMs,
      },
    );
    // A terminal result closes steering input: reject unconsumed steering now so
    // completion delivery uses its fallback path, and so a deadline interrupt
    // cannot drop accepted pending input later.
    turnRuntime.steeringQueueRef.current?.cancel();
    // The assistant-completion recovery watch interrupts on release; the
    // terminal-release deadline owns post-release interruption from here.
    turnWatches.disarmAssistantCompletionIdleWatch();
    // Interrupting here would persist Codex's "user interrupted" marker into
    // the thread rollout on every clean close. Instead wait for Codex's own
    // turn/completed (the terminal notification path completes and resolves),
    // bounded by an absolute deadline. The completion idle watch stays armed
    // as the backstop if Codex never answers the deadline interrupt.
    state.terminalReleaseAwaitingTurnCompletion = {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      tool: value.call.tool,
      interruptRequested: false,
    };
    turnWatches.armTerminalReleaseDeadline({
      deadlineMs: CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
      onDeadline: () => interruptTurnForTerminalRelease("completion_deadline"),
    });
  };
  const interruptTurnForTerminalRelease = (
    cause: "completion_deadline" | "new_inbound_message",
  ) => {
    const pending = state.terminalReleaseAwaitingTurnCompletion;
    if (
      !pending ||
      pending.interruptRequested ||
      state.completed ||
      runAbortController.signal.aborted
    ) {
      return;
    }
    // Attribution must precede the RPC: terminal classification reads this flag
    // to keep an OpenClaw-initiated release from counting as a user abort.
    pending.interruptRequested = true;
    turnWatches.clearTerminalReleaseDeadline();
    trajectoryRecorder?.recordEvent("turn.terminal_release_interrupt", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      toolCallId: pending.toolCallId,
      name: pending.tool,
      cause,
      deadlineMs: CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
    });
    embeddedAgentLog.warn(
      "codex app-server turn still active after terminal release; interrupting",
      {
        threadId: pending.threadId,
        turnId: pending.turnId,
        toolCallId: pending.toolCallId,
        tool: pending.tool,
        cause,
      },
    );
    turnRuntime.steeringQueueRef.current?.cancel();
    interruptCodexTurnBestEffort(resourceState.client, {
      threadId: pending.threadId,
      turnId: pending.turnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
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
      if (
        state.pendingTerminalDynamicToolRelease?.response.success === true &&
        !state.currentTurnHadNonTerminalDynamicToolResult &&
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
        currentTurnHadNonTerminalDynamicToolResult:
          state.currentTurnHadNonTerminalDynamicToolResult,
        hasPendingTerminalDynamicToolRelease: state.pendingTerminalDynamicToolRelease !== undefined,
      });
      if (action === "release-pending-terminal" && state.pendingTerminalDynamicToolRelease) {
        releaseTurnAfterTerminalDynamicTool(state.pendingTerminalDynamicToolRelease);
      } else if (action === "clear-nonterminal-batch") {
        state.pendingTerminalDynamicToolRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
      }
    });
    immediate.unref?.();
  };
  const scheduleTurnReleaseAfterTerminalDynamicTool = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    state.pendingTerminalDynamicToolRelease = value;
    scheduleTerminalDynamicToolReleaseCheck();
  };
  const emitLifecycleStart = () => {
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    state.lifecycleStarted = true;
  };
  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (!state.lifecycleStarted || state.lifecycleTerminalEmitted) {
      return;
    }
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
        ...(params.deferTerminalLifecycle ? { phase: "finishing" } : {}),
      },
    });
    state.lifecycleTerminalEmitted = true;
  };
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
  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (
    key: string,
    info: Parameters<NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>>[0],
  ) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.onExecutionPhase?.({
      provider: params.provider,
      model: params.modelId,
      backend: "codex-app-server",
      ...info,
    });
  };
  const reportExecutionNotification = (notification: CodexServerNotification) => {
    reportCodexExecutionNotification({ notification, emitExecutionPhaseOnce });
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
  const maybeEmitFastModeAutoReset = async () => {
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
  };
  const maybeEmitFastModeAutoResetBestEffort = async () => {
    try {
      await maybeEmitFastModeAutoReset();
    } catch (error) {
      embeddedAgentLog.warn(
        `codex app-server fast mode auto reset progress failed: ${formatErrorMessage(error)}`,
      );
    }
  };
  return {
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
