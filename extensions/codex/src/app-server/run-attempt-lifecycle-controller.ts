import { createAgentHarnessAttemptLifecycle } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  embeddedAgentLog,
  FAST_MODE_AUTO_PROGRESS_KIND,
  formatErrorMessage,
  formatFastModeAutoProgressText,
  resolveAgentRunAbortLifecycleFields,
  resolveFastModeForElapsed,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexNotificationItem, readRawResponseToolCallId } from "./attempt-notifications.js";
import { itemName } from "./event-projector-items.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  isJsonObject,
  type CodexServerNotification,
} from "./protocol.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export function createCodexAttemptLifecycleController(
  resources: StartedCodexAttemptResources,
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
  type ModelResponse = {
    closed: boolean;
    calls: Map<string, { direct: boolean; result?: TerminalToolRelease }>;
  };
  // Raw model-call receipts precede dispatch; item/started and request registration
  // can lag. Only rawResponse/completed closes the model's call inventory.
  let modelResponse: ModelResponse | undefined;
  let independentTerminalRelease: TerminalToolRelease | undefined;
  let lastClosedResponseId: string | undefined;
  let terminalSteeringDrainPending = false;
  const resolveAuthoredResponse = () => {
    if (!modelResponse?.closed || modelResponse.calls.size === 0) {
      return undefined;
    }
    const results: TerminalToolRelease[] = [];
    for (const { result } of modelResponse.calls.values()) {
      if (!result?.response.success || result.response.terminate !== true) {
        return undefined;
      }
      results.push(result);
    }
    const payloads = results.flatMap((result) =>
      result.response.toolAuthoredSourceReply ? [result.response.toolAuthoredSourceReply] : [],
    );
    // An authored sibling cannot restore a delivered reply's terminal authority
    // after steering. An explicit yield still owns its independent release.
    const value =
      results.some(({ response }) => response.finalSourceReplyDelivered) &&
      turnRuntime.steeringQueueRef.current?.hasSubmittedMessages()
        ? independentTerminalRelease
        : results[0];
    return value && payloads.length > 0 ? { value, payloads } : undefined;
  };
  const scheduleTerminalDynamicToolReleaseCheck = () => {
    if (
      state.terminalDynamicToolReleaseCheckScheduled ||
      terminalSteeringDrainPending ||
      (!state.pendingTerminalDynamicToolRelease &&
        !state.currentTurnHadNonTerminalDynamicToolResult &&
        !resolveAuthoredResponse())
    ) {
      return;
    }
    // The JSON-RPC response must flush before the terminal tool interrupts its turn.
    state.terminalDynamicToolReleaseCheckScheduled = true;
    const immediate = setImmediate(() => {
      state.terminalDynamicToolReleaseCheckScheduled = false;
      // An idle gap cannot finish an open inventory or skip a direct call whose
      // request has not registered yet: either may still contribute an authored reply.
      if (
        modelResponse &&
        (!modelResponse.closed ||
          [...modelResponse.calls.values()].some((call) => call.direct && !call.result))
      ) {
        return;
      }
      if (
        state.pendingTerminalDynamicToolRelease?.response.finalSourceReplyDelivered === true &&
        turnRuntime.steeringQueueRef.current?.hasSubmittedMessages()
      ) {
        // This reply may answer the input preceding a steer. Native scheduling
        // must consume and answer the new input before the turn ends; even a
        // consumption receipt does not prove the model has answered it.
        // Discard only that reply's terminal authority. An independent terminal
        // sibling (for example sessions_yield) still owns its existing release.
        state.pendingTerminalDynamicToolRelease = [...(modelResponse?.calls.values() ?? [])].some(
          (call) => call.result?.response.toolAuthoredSourceReply,
        )
          ? undefined
          : independentTerminalRelease;
      }
      const deliveredFinal =
        state.pendingTerminalDynamicToolRelease?.response.finalSourceReplyDelivered === true;
      const authored = deliveredFinal ? undefined : resolveAuthoredResponse();
      if (
        !authored &&
        (deliveredFinal || state.pendingTerminalDynamicToolRelease?.response.success === true) &&
        (deliveredFinal || !state.currentTurnHadNonTerminalDynamicToolResult) &&
        state.activeAppServerTurnRequests === 0 &&
        pendingOpenClawDynamicToolCompletionIds.size === 0
      ) {
        // Tool response flush plus sibling classification commits terminal release.
        // Fence new input now, but keep submitted input eligible for consumption.
        turnRuntime.steeringQueueRef.current?.sealAdmission();
      }
      if (
        state.activeAppServerTurnRequests > 0 ||
        activeTurnItemIds.size > 0 ||
        pendingOpenClawDynamicToolCompletionIds.size > 0
      ) {
        return;
      }
      if (!authored && !deliveredFinal && state.currentTurnHadNonTerminalDynamicToolResult) {
        state.pendingTerminalDynamicToolRelease = undefined;
        independentTerminalRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
        return;
      }
      const value = authored?.value ?? state.pendingTerminalDynamicToolRelease;
      if (
        !value ||
        state.completed ||
        runAbortController.signal.aborted ||
        (!value.response.success && !deliveredFinal)
      ) {
        return;
      }
      const steeringDrain = turnRuntime.steeringQueueRef.current?.drainBeforeCancel();
      if (steeringDrain) {
        terminalSteeringDrainPending = true;
        void steeringDrain.then(() => {
          terminalSteeringDrainPending = false;
          scheduleTerminalDynamicToolReleaseCheck();
        });
        return;
      }
      state.pendingTerminalDynamicToolRelease = undefined;
      independentTerminalRelease = undefined;
      modelResponse = undefined;
      if (authored) {
        prompt.context.attemptTools.toolBridge.telemetry.messagingToolSourceReplyPayloads.push(
          ...authored.payloads,
        );
      }
      trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
        threadId: value.call.threadId,
        turnId: value.call.turnId,
        toolCallId: value.call.callId,
        name: value.call.tool,
        durationMs: value.durationMs,
      });
      embeddedAgentLog.info("codex app-server turn released after terminal dynamic tool result", {
        threadId: value.call.threadId,
        turnId: value.call.turnId,
        toolCallId: value.call.callId,
        tool: value.call.tool,
        durationMs: value.durationMs,
      });
      // Foreground yield may complete immediately, but subscription transfer must
      // join the exact native turn's stop before another parent turn can start.
      state.abortCleanup = turnRuntime
        .interruptTurn(value.call.turnId, { locallyCompleted: true })
        .then(() => {});
      turnRuntime.completeTurn();
    });
    immediate.unref?.();
  };
  const recordDynamicToolResult = (value: TerminalToolRelease) => {
    if (
      value.response.success &&
      value.response.terminate === true &&
      !value.response.finalSourceReplyDelivered &&
      !value.response.toolAuthoredSourceReply
    ) {
      // Nested Code Mode calls are absent from the outer raw-call inventory.
      independentTerminalRelease = value;
    }
    const modelCall = modelResponse?.calls.get(value.call.callId);
    if (modelCall) {
      modelCall.result = value;
    }
    if (value.response.toolAuthoredSourceReply) {
      // Once this raw batch has an authored candidate, only whole-batch admission
      // can finish it. An ordinary sibling cannot leave a fallback that drops it.
      if (
        modelCall &&
        !state.pendingTerminalDynamicToolRelease?.response.finalSourceReplyDelivered
      ) {
        state.pendingTerminalDynamicToolRelease = undefined;
      }
      // A nested or unobserved call cannot borrow the outer model call's authority.
      scheduleTerminalDynamicToolReleaseCheck();
      return;
    }
    if (
      value.response.terminate === true &&
      (value.response.success || value.response.finalSourceReplyDelivered)
    ) {
      if (
        value.response.finalSourceReplyDelivered ||
        (!state.pendingTerminalDynamicToolRelease?.response.finalSourceReplyDelivered &&
          ![...(modelResponse?.calls.values() ?? [])].some(
            (call) => call.result?.response.toolAuthoredSourceReply,
          ))
      ) {
        state.pendingTerminalDynamicToolRelease = value;
      }
      scheduleTerminalDynamicToolReleaseCheck();
    } else if (value.response.success && value.response.asyncStarted === true) {
      scheduleTerminalDynamicToolReleaseCheck();
    } else {
      state.currentTurnHadNonTerminalDynamicToolResult = true;
      if (!state.pendingTerminalDynamicToolRelease?.response.finalSourceReplyDelivered) {
        state.pendingTerminalDynamicToolRelease = undefined;
        independentTerminalRelease = undefined;
      }
    }
  };
  const recordModelResponseNotification = (notification: CodexServerNotification) => {
    const notificationParams = notification.params;
    if (!isJsonObject(notificationParams)) {
      return;
    }
    if (notification.method === "rawResponse/completed") {
      const responseId = notificationParams.responseId;
      if (typeof responseId !== "string" || !responseId || responseId === lastClosedResponseId) {
        return;
      }
      lastClosedResponseId = responseId;
      if (!modelResponse || modelResponse.closed) {
        independentTerminalRelease = undefined;
        modelResponse = { closed: false, calls: new Map() };
      }
      modelResponse.closed = true;
      scheduleTerminalDynamicToolReleaseCheck();
      return;
    }
    if (
      notification.method !== "rawResponseItem/completed" ||
      !isJsonObject(notificationParams.item)
    ) {
      return;
    }
    const callId = readRawResponseToolCallId(notification);
    const item = notificationParams.item;
    const startsModelResponse =
      callId !== undefined ||
      item.type === "reasoning" ||
      (item.type === "message" && item.role === "assistant");
    if (!startsModelResponse) {
      return;
    }
    // Tool output receipts are deliberately excluded: they arrive after the raw
    // response closes and must not reopen or retire that response's admission.
    if (!modelResponse || modelResponse.closed) {
      independentTerminalRelease = undefined;
      modelResponse = { closed: false, calls: new Map() };
    }
    if (callId && !modelResponse.calls.has(callId)) {
      modelResponse.calls.set(callId, {
        direct: item.namespace === CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      });
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
    recordModelResponseNotification,
    recordDynamicToolResult,
    scheduleTerminalDynamicToolReleaseCheck,
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
