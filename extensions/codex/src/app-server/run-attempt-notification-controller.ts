import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  applyCodexTurnNotificationState,
  isTerminalCodexTurnNotificationForTurn,
} from "./attempt-notification-state.js";
import {
  codexExecutionToolName,
  describeNotificationActivity,
  isAssistantCompletionReleaseNotification,
  isRawFunctionToolOutputCompletionNotification,
  readCodexNotificationItem,
  readRawResponseToolCallId,
} from "./attempt-notifications.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import type { CodexServerNotification, CodexThreadItem } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import {
  readCodexFinalizationHookNotification,
  waitForCodexNotificationDispatchTurn,
} from "./run-attempt-state.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS } from "./turn-router.js";
import type { CodexThreadRouteScope } from "./turn-router.js";

export function createCodexAttemptNotificationController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
) {
  const {
    prompt,
    state: resourceState,
    projectorRef,
    registerNativeSubagentMonitor,
    runSafety,
  } = resources;
  const { context, turnState } = prompt;
  const { attemptTools, runtime } = context;
  const { connection } = runtime;
  const { appServer, runAbortController } = connection;
  const { allocateCodexToolOutcomeOrdinal } = attemptTools;
  const {
    state,
    turnIdRef,
    userInputBridgeRef,
    steeringQueueRef,
    turnWatches,
    activeTurnItemIds,
    activeCompletionBlockerItemIds,
    activeFinalizationHookRunIds,
    finalizationHookBatchStatuses,
    pendingOpenClawDynamicToolCompletionIds,
    postToolRawAssistantCompletionIdleTimeoutMs,
  } = turnRuntime;
  const {
    scheduleTerminalDynamicToolReleaseCheck,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
  } = lifecycle;
  const isTerminalTurnNotificationForTurn = (
    notification: CodexServerNotification,
    notificationTurnId: string,
  ) =>
    isTerminalCodexTurnNotificationForTurn({
      notification,
      threadId: resourceState.thread.threadId,
      turnId: notificationTurnId,
    });
  const handleNotification = async (notification: CodexServerNotification) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    const steeringQueue = steeringQueueRef.current;
    userInputBridgeRef.current?.handleNotification(notification);
    if (!projector || !turnId) {
      if (notification.method === "error") {
        state.latestStartupErrorNotification = notification;
      }
      return;
    }
    const notificationState = applyCodexTurnNotificationState({
      notification,
      threadId: resourceState.thread.threadId,
      turnId,
      currentPromptTexts: [turnState.codexTurnPromptText],
      turnWatches,
      activeTurnItemIds,
      activeCompletionBlockerItemIds,
      activeAppServerTurnRequests: state.activeAppServerTurnRequests,
      pendingOpenClawDynamicToolCompletionIds,
      turnCrossedToolHandoff: state.turnCrossedToolHandoff,
      postToolRawAssistantCompletionIdleTimeoutMs,
      onScheduleTerminalDynamicToolReleaseCheck: scheduleTerminalDynamicToolReleaseCheck,
      onReportExecutionNotification: reportExecutionNotification,
    });
    state.turnCrossedToolHandoff = notificationState.turnCrossedToolHandoff;
    if (notificationState.isCurrentTurnNotification && notification.method === "item/completed") {
      const item = readCodexNotificationItem(notification.params);
      if (item?.type === "userMessage" && typeof item.clientId === "string") {
        steeringQueue?.confirmConsumed(item.clientId);
      }
    }
    if (notificationState.isTurnAbortMarker) {
      state.sawCodexInterruptMarker = true;
    }
    const hookNotification = readCodexFinalizationHookNotification(
      notification,
      resourceState.thread.threadId,
      turnId,
    );
    if (hookNotification?.phase === "started") {
      if (activeFinalizationHookRunIds.size === 0) {
        finalizationHookBatchStatuses.clear();
      }
      activeFinalizationHookRunIds.add(hookNotification.runId);
      turnWatches.disarmAssistantCompletionIdleWatch();
    }
    if (notificationState.isTurnTerminal) {
      state.terminalTurnNotificationQueued = true;
    }
    try {
      await waitForCodexNotificationDispatchTurn();
      await projector.handleNotification(notification);
      const canRelease =
        isAssistantCompletionReleaseNotification(notification, state.turnCrossedToolHandoff) ||
        (notificationState.isCurrentTurnNotification &&
          state.turnCrossedToolHandoff &&
          notification.method === "rawResponseItem/completed" &&
          projector.canReleaseLatestTerminalAssistantAfterToolHandoff());
      if (notificationState.isCurrentTurnNotification && canRelease) {
        const itemId = projector.getLatestTerminalAssistantCandidate()?.itemId;
        if (
          state.rejectedFinalizationHookAssistant &&
          itemId &&
          itemId !== state.rejectedFinalizationHookAssistant.itemId
        ) {
          state.rejectedFinalizationHookAssistant = undefined;
        } else if (state.rejectedFinalizationHookAssistant) {
          turnWatches.disarmAssistantCompletionIdleWatch();
        } else if (
          activeFinalizationHookRunIds.size === 0 &&
          !state.terminalTurnNotificationQueued &&
          state.activeAppServerTurnRequests === 0 &&
          activeTurnItemIds.size === 0 &&
          activeCompletionBlockerItemIds.size === 0 &&
          pendingOpenClawDynamicToolCompletionIds.size === 0 &&
          projector.hasLatestTerminalAssistantCandidateText()
        ) {
          turnWatches.armAssistantCompletionIdleWatch(describeNotificationActivity(notification));
        }
      }
      if (
        notificationState.isCurrentTurnNotification &&
        activeTurnItemIds.size === 0 &&
        isRawFunctionToolOutputCompletionNotification(notification)
      ) {
        await maybeAnnounceFastModeAutoOff();
      }
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (hookNotification?.phase === "completed") {
        state.unsettledFinalizationHookCount = Math.max(
          0,
          state.unsettledFinalizationHookCount - 1,
        );
        activeFinalizationHookRunIds.delete(hookNotification.runId);
        finalizationHookBatchStatuses.set(hookNotification.runId, hookNotification.status);
        if (activeFinalizationHookRunIds.size === 0) {
          const statuses = new Set(finalizationHookBatchStatuses.values());
          if (statuses.has("blocked") && !statuses.has("stopped")) {
            const itemId = projector.getLatestTerminalAssistantCandidate()?.itemId;
            state.rejectedFinalizationHookAssistant = itemId ? { itemId } : {};
            turnWatches.disarmAssistantCompletionIdleWatch();
          } else {
            state.rejectedFinalizationHookAssistant = undefined;
          }
        }
        if (
          activeFinalizationHookRunIds.size === 0 &&
          state.rejectedFinalizationHookAssistant === undefined &&
          !state.terminalTurnNotificationQueued &&
          state.activeAppServerTurnRequests === 0 &&
          activeTurnItemIds.size === 0 &&
          activeCompletionBlockerItemIds.size === 0 &&
          pendingOpenClawDynamicToolCompletionIds.size === 0 &&
          projector.hasLatestTerminalAssistantCandidateText()
        ) {
          turnWatches.armAssistantCompletionIdleWatch({
            lastNotificationMethod: notification.method,
            hookRunId: hookNotification.runId,
            hookStatus: hookNotification.status,
          });
        }
      }
      if (notificationState.isTurnTerminal) {
        const completedTurn = readCodexTurnCompletedNotification(notification.params)?.turn;
        // App-server collapses abort reasons; interrupted plus this marker is the
        // only user-interrupt discriminator until Codex exposes abortReason.
        if (completedTurn?.status === "interrupted" && state.sawCodexInterruptMarker) {
          projector.markAborted();
        }
        if (!state.timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        state.completed = true;
        turnWatches.clearCompletionIdleTimer();
        turnWatches.clearAssistantCompletionIdleTimer();
        turnWatches.clearTerminalIdleTimer();
        state.resolveCompletion?.();
      }
    }
  };
  const waitForActiveNativeTurnCompletion = async () => {
    const route = resourceState.turnRoute;
    if (!route) {
      return false;
    }
    return await route.waitForTurnCompletion({
      timeoutMs: Math.min(appServer.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      signal: runAbortController.signal,
    });
  };
  const noteNotificationReceived = (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    if (!projector || !turnId) {
      return;
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      state.terminalTurnNotificationQueued = true;
    }
    if (scope.turnId === turnId) {
      const modelToolCallId = readRawResponseToolCallId(notification);
      if (modelToolCallId) {
        allocateCodexToolOutcomeOrdinal?.(modelToolCallId);
      }
      const nativeItem = readCodexNotificationItem(notification.params);
      if (
        nativeItem &&
        (notification.method === "item/started" || notification.method === "item/completed")
      ) {
        const toolAttempt = readCodexRunSafetyToolAttempt(nativeItem);
        if (toolAttempt) {
          runSafety.recordToolCall(toolAttempt);
          if (notification.method === "item/completed") {
            const outcome = readCodexRunSafetyToolOutcome(nativeItem);
            if (outcome) {
              runSafety.recordToolOutcome({ ...toolAttempt, ...outcome });
            }
          }
        }
      }
      if (nativeItem?.type === "webSearch") {
        projector.recordNativeToolOutcome(nativeItem);
      }
    }
    const hookNotification = readCodexFinalizationHookNotification(
      notification,
      resourceState.thread.threadId,
      turnId,
    );
    if (hookNotification?.phase === "started") {
      state.unsettledFinalizationHookCount += 1;
      turnWatches.disarmAssistantCompletionIdleWatch();
    }
    turnWatches.noteNotificationReceived(notification.method, { receivedAtMs });
  };
  const enqueueNotification = async (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
  ) => {
    embeddedAgentLog.trace("codex app-server raw notification received", {
      method: notification.method,
      ...scope,
    });
    await handleNotification(notification);
  };
  const drainNotificationQueue = async () => {
    await resourceState.turnRoute?.drain();
  };
  registerNativeSubagentMonitor(resourceState.thread.threadId);
  return {
    waitForActiveNativeTurnCompletion,
    noteNotificationReceived,
    enqueueNotification,
    drainNotificationQueue,
  };
}

export type CodexAttemptNotificationController = ReturnType<
  typeof createCodexAttemptNotificationController
>;

function readCodexRunSafetyToolAttempt(item: CodexThreadItem) {
  const toolName = codexExecutionToolName(item) ?? readAdditionalCodexToolName(item);
  if (!toolName) {
    return undefined;
  }
  const args =
    item.type === "commandExecution"
      ? { command: item.command }
      : item.type === "fileChange"
        ? { changes: item.changes }
        : item.type === "webSearch"
          ? { query: item.query }
          : item.type === "collabAgentToolCall"
            ? {
                tool: item.tool,
                prompt: item.prompt,
                model: item.model,
                receiverThreadIds: item.receiverThreadIds,
              }
            : item.type === "sleep"
              ? { durationMs: item.durationMs }
              : item.arguments;
  return {
    toolName,
    toolCallId: item.id,
    ...(args !== undefined ? { arguments: args } : {}),
  };
}

function readAdditionalCodexToolName(item: CodexThreadItem): string | undefined {
  switch (item.type) {
    case "collabAgentToolCall":
      return typeof item.tool === "string" && item.tool ? item.tool : "collaboration";
    case "imageGeneration":
      return "image_generation";
    case "imageView":
      return "view_image";
    case "sleep":
      return "clock.sleep";
    default:
      return undefined;
  }
}

function readCodexRunSafetyToolOutcome(item: CodexThreadItem) {
  const status = item.status?.trim().toLowerCase();
  if (status === "completed" || status === "succeeded" || status === "success") {
    return { success: true as const };
  }
  if (status !== "failed" && status !== "error" && status !== "declined") {
    return undefined;
  }
  return {
    success: false as const,
    error:
      item.aggregatedOutput?.trim() ||
      safeCodexRunSafetyValue(item.error) ||
      safeCodexRunSafetyValue(item.result) ||
      status,
  };
}

function safeCodexRunSafetyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}
