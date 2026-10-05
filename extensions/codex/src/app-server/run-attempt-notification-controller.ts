import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { acknowledgeInternalToolResult } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  isCodexTurnAbortMarkerNotification,
  completePendingOpenClawDynamicToolNotification,
  isRawFunctionToolOutputCompletionNotification,
  readCodexNotificationItem,
  readRawResponseToolCallId,
  updateActiveTurnItemIds,
} from "./attempt-notifications.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import type { CodexServerNotification } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { projectCodexSessionWarning } from "./session-warnings.js";
import { waitForPromiseOrAbort } from "./timeout.js";
import { CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS } from "./turn-router.js";
import type { CodexThreadRouteScope } from "./turn-router.js";

export function createCodexAttemptNotificationController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
) {
  const { prompt, state: resourceState, projectorRef } = resources;
  const { context, turnState } = prompt;
  const { attemptTools, runtime } = context;
  const { appServer, runAbortController } = runtime.connection;
  const { allocateCodexToolOutcomeOrdinal } = attemptTools;
  const {
    state,
    turnIdRef,
    steeringQueueRef,
    activeTurnItemIds,
    pendingOpenClawDynamicToolCompletionIds,
    openClawDynamicToolExecutions,
    completeTurn,
    clearTerminalReleaseDeadline,
    noteProgress,
    deadlines,
  } = turnRuntime;
  const {
    scheduleTerminalDynamicToolReleaseCheck,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
  } = lifecycle;
  const pendingNativeCommandItems = new Set<string>();
  let nativeItemsCompletion: ReturnType<typeof createDeferred<void>> | undefined;
  const waitForNativeTerminalItems = async (signal: AbortSignal) => {
    // Exited commands disappear from native inventory before their final item arrives.
    // Receipt-owned command facts exclude older turns and withheld dynamic replies.
    if (pendingNativeCommandItems.size === 0) {
      return;
    }
    const completion = (nativeItemsCompletion ??= createDeferred<void>());
    if (!(await waitForPromiseOrAbort(completion.promise, signal))) {
      signal.throwIfAborted();
    }
  };
  const readTerminalTurn = (notification: CodexServerNotification, notificationTurnId: string) =>
    notification.method === "turn/completed" &&
    isCodexNotificationForTurn(
      notification.params,
      resourceState.thread.threadId,
      notificationTurnId,
    )
      ? readCodexTurnCompletedNotification(notification.params)?.turn
      : undefined;
  const handleNotification = async (notification: CodexServerNotification) => {
    if (state.projectionClosed) {
      return;
    }
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    if (!projector || !turnId) {
      if (notification.method === "error") {
        state.latestStartupErrorNotification = notification;
      }
      return;
    }
    const isCurrentTurn = isCodexNotificationForTurn(
      notification.params,
      resourceState.thread.threadId,
      turnId,
    );
    const completedTurn = readTerminalTurn(notification, turnId);
    if (
      (state.timeout || state.localCompletionRequested) &&
      completedTurn?.status === "interrupted"
    ) {
      // Cleanup's interrupt confirms stop; it cannot replace the result or
      // usage already owned by an execution deadline or terminal tool.
      completeTurn();
      return;
    }
    state.activeLocalProjections += 1;
    try {
      if (isCurrentTurn) {
        updateActiveTurnItemIds(notification, activeTurnItemIds);
        noteProgress(`notification:${notification.method}`);
        reportExecutionNotification(notification);
        completePendingOpenClawDynamicToolNotification(
          notification,
          pendingOpenClawDynamicToolCompletionIds,
        );
        if (notification.method === "item/completed") {
          if (activeTurnItemIds.size === 0) {
            scheduleTerminalDynamicToolReleaseCheck();
          }
          const item = readCodexNotificationItem(notification.params);
          if (item?.type === "dynamicToolCall") {
            const response = await openClawDynamicToolExecutions.get({
              threadId: resourceState.thread.threadId,
              turnId,
              callId: item.id,
            });
            // Codex emits these fields after accepting the response; decode failures
            // instead complete with a replacement error. A pipe write is not acceptance.
            if (
              response &&
              !state.projectionClosed &&
              !runAbortController.signal.aborted &&
              turnIdRef.current === turnId &&
              item.success === response.success &&
              isDeepStrictEqual(item.contentItems, response.contentItems)
            ) {
              acknowledgeInternalToolResult(response);
            }
          }
          if (item?.type === "userMessage" && typeof item.clientId === "string") {
            steeringQueueRef.current?.confirmConsumed(item.clientId);
          }
        }
        if (
          isCodexTurnAbortMarkerNotification(notification, {
            currentPromptText: turnState.codexTurnPromptText,
          })
        ) {
          state.sawCodexInterruptMarker = true;
        }
      }
      if (notification.method === "warning" || notification.method === "configWarning") {
        const { params, sessionAgentId, assertCurrent } = runtime.connection;
        await projectCodexSessionWarning({
          session: {
            agentId: sessionAgentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionTarget?.sessionKey ?? params.sessionKey,
            storePath:
              params.sessionTarget?.storePath ??
              resolveStorePath(params.config?.session?.store, { agentId: sessionAgentId }),
            expectedLifecycleRevision: params.sessionTarget?.expectedLifecycleRevision,
          },
          threadId: resourceState.thread.threadId,
          notification,
          assertCurrent,
          project: async () => {
            if (
              state.projectionClosed ||
              projectorRef.current !== projector ||
              turnIdRef.current !== turnId
            ) {
              return false;
            }
            await projector.handleNotification(notification);
            return true;
          },
        });
      } else {
        await projector.handleNotification(notification);
      }
      if (
        isCurrentTurn &&
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
      state.activeLocalProjections -= 1;
      if (isCurrentTurn && notification.method === "item/completed") {
        const item = readCodexNotificationItem(notification.params);
        if (item?.type === "commandExecution") {
          pendingNativeCommandItems.delete(item.id);
        }
      }
      if (pendingNativeCommandItems.size === 0) {
        nativeItemsCompletion?.resolve();
        nativeItemsCompletion = undefined;
      }
      if (completedTurn) {
        // App-server collapses abort reasons; the marker preserves explicit
        // native user interruption without treating marker text as terminal.
        if (completedTurn.status === "interrupted" && state.sawCodexInterruptMarker) {
          projector.markAborted();
        }
        completeTurn();
      }
    }
  };
  const waitForActiveNativeTurnCompletion = async () => {
    const route = resourceState.turnRoute;
    const activeNativeTurnId =
      resourceState.thread.lifecycle.activeTurnIds?.at(-1) ?? route?.observedNativeTurnId;
    if (!route || !activeNativeTurnId) {
      return false;
    }
    const watch = resourceState.turnRouter.watchNativeTurnCompletion({
      threadId: route.threadId,
      turnId: activeNativeTurnId,
      timeoutMs: Math.min(appServer.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      signal: runAbortController.signal,
    });
    try {
      return await watch.completion;
    } finally {
      watch.cancel();
    }
  };
  const noteNotificationReceived = (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    if (!projector || !turnId || state.projectionClosed) {
      return;
    }
    projector.recordMcpToolCallReceipt(notification);
    const completedTurn = readTerminalTurn(notification, turnId);
    if (completedTurn) {
      projector.settlement.terminalReceipt = completedTurn;
      state.terminalTurnNotificationQueued = true;
      clearTerminalReleaseDeadline();
      steeringQueueRef.current?.sealAdmission();
      deadlines.beginSettlement(receivedAtMs);
    }
    if (scope.turnId === turnId) {
      const modelToolCallId = readRawResponseToolCallId(notification);
      if (modelToolCallId) {
        allocateCodexToolOutcomeOrdinal?.(modelToolCallId);
      }
      const nativeItem = readCodexNotificationItem(notification.params);
      if (notification.method === "item/started" && nativeItem?.type === "commandExecution") {
        pendingNativeCommandItems.add(nativeItem.id);
      }
      if (nativeItem?.type === "webSearch") {
        // Native result provenance must survive an abandoned transcript projection.
        projector.settlement.turnTainted ||= notification.method === "item/completed";
        projector.recordNativeToolOutcome(nativeItem);
      }
    }
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
  return {
    waitForActiveNativeTurnCompletion,
    waitForNativeTerminalItems,
    noteNotificationReceived,
    enqueueNotification,
    drainNotificationQueue,
  };
}

export type CodexAttemptNotificationController = ReturnType<
  typeof createCodexAttemptNotificationController
>;
