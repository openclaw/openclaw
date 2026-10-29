import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { acknowledgeInternalToolResult } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  isCodexTurnAbortMarkerNotification,
  isTerminalTurnStatus,
  isPendingOpenClawDynamicToolCompletionNotification,
  isRawFunctionToolOutputCompletionNotification,
  readCodexNotificationItem,
  readNotificationItemId,
  readRawResponseToolCallId,
  updateActiveTurnItemIds,
} from "./attempt-notifications.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import { isJsonObject, type CodexServerNotification, type CodexThreadItem } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { withAbortableTimeout, waitForPromiseOrAbort } from "./timeout.js";
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
    noteProgress,
    deadlines,
  } = turnRuntime;
  const {
    scheduleTerminalDynamicToolReleaseCheck,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
  } = lifecycle;
  const pendingNativeCommandItems = new Set<string>();
  const nativeItemObservers = new Set<() => void>();
  const waitForNativeTerminalItems = async (signal: AbortSignal) => {
    // Exited commands disappear from native inventory before their final item arrives.
    // Receipt-owned command facts exclude older turns and withheld dynamic replies.
    if (pendingNativeCommandItems.size === 0) {
      return;
    }
    const completion = createDeferred<void>();
    const observe = () => {
      if (pendingNativeCommandItems.size === 0) {
        completion.resolve();
      }
    };
    nativeItemObservers.add(observe);
    try {
      observe();
      if (!(await waitForPromiseOrAbort(completion.promise, signal))) {
        signal.throwIfAborted();
      }
    } finally {
      nativeItemObservers.delete(observe);
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
  const acknowledgeCompletedDynamicTool = async (item: CodexThreadItem, turnId: string) => {
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
      if (response.terminate && response.success && item.status === "completed") {
        response.nativeResultAcknowledged = true;
      }
    }
  };
  const handleNotification = async (incomingNotification: CodexServerNotification) => {
    let notification = incomingNotification;
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
    if (completedTurn && state.recoveredTurnId === turnId) {
      try {
        const connection = runtime.connection;
        const client = resourceState.client;
        const assertCurrent = () => {
          runAbortController.signal.throwIfAborted();
          connection.assertCurrent();
          resourceState.thread.liveThreadOwnership?.assertCurrent();
          if (
            !isSameCodexAppServerThreadOwner(
              connection.bindingStore.read(connection.bindingIdentity),
              resourceState.thread,
            ) ||
            resourceState.client !== client ||
            turnIdRef.current !== turnId ||
            state.projectionClosed
          ) {
            throw new Error("Recovered Codex terminal projection lost its owner");
          }
        };
        assertCurrent();
        if (!isTerminalTurnStatus(completedTurn.status)) {
          throw new Error("Recovered Codex completion has no terminal proof");
        }
        // All these pending requests belong to the now-terminal native turn.
        // Cancel before joining old projection tails that may await their results.
        for (const controller of turnRuntime.pendingDynamicToolAbortControllers) {
          controller.abort(new CodexServerRequestResolvedError());
        }
        await withAbortableTimeout({
          promise: state.recoveredProjectionDrain ?? Promise.resolve(),
          timeoutMs: appServer.requestTimeoutMs,
          signal: runAbortController.signal,
          timeoutMessage: "Recovered Codex projection did not settle",
        });
        assertCurrent();
        const response = await client.request(
          "thread/turns/list",
          {
            threadId: resourceState.thread.threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          {
            signal: runAbortController.signal,
            timeoutMs: appServer.requestTimeoutMs,
            assertCurrent,
            withCurrent: connection.authority.withCurrent,
          },
        );
        assertCurrent();
        const snapshot = response.data[0];
        if (
          response.data.length !== 1 ||
          !snapshot ||
          snapshot.id !== turnId ||
          snapshot.status !== completedTurn.status ||
          !Array.isArray(snapshot.items)
        ) {
          throw new Error("Recovered Codex terminal history does not match its original turn");
        }
        for (const item of snapshot.items) {
          if (
            item.type === "dynamicToolCall" &&
            ["completed", "failed"].includes(item.status ?? "")
          ) {
            await acknowledgeCompletedDynamicTool(item, turnId);
            assertCurrent();
          }
        }
        const reconciled = await projector.reconcileRecoveredTurn(
          snapshot,
          completedTurn,
          assertCurrent,
        );
        assertCurrent();
        await projector.transcriptCheckpoint.flush();
        assertCurrent();
        if (!isJsonObject(reconciled) || !isJsonObject(notification.params)) {
          throw new Error("Recovered Codex terminal history is not a JSON object");
        }
        notification = { ...notification, params: { ...notification.params, turn: reconciled } };
        state.recoveredTurnId = undefined;
      } catch (error) {
        // This is a recovery failure, not an ordinary best-effort UI projection.
        // Do not swallow it and publish a successful terminal result or retry tools.
        resourceState.remoteRecoveryFailed = true;
        state.clientClosedPromptError =
          "Codex recovery could not safely reconcile the previous task history.";
        state.clientClosedDiagnostic = error instanceof Error ? error.message : String(error);
        state.clientClosedAbort = true;
        runAbortController.abort(error);
        completeTurn();
        return;
      }
    }
    state.activeLocalProjections += 1;
    try {
      if (isCurrentTurn) {
        updateActiveTurnItemIds(notification, activeTurnItemIds);
        noteProgress(`notification:${notification.method}`);
        reportExecutionNotification(notification);
        if (
          isPendingOpenClawDynamicToolCompletionNotification(
            notification,
            pendingOpenClawDynamicToolCompletionIds,
          )
        ) {
          const itemId = readNotificationItemId(notification);
          if (itemId) {
            pendingOpenClawDynamicToolCompletionIds.delete(itemId);
          }
        }
        if (notification.method === "item/completed") {
          if (activeTurnItemIds.size === 0) {
            scheduleTerminalDynamicToolReleaseCheck();
          }
          const item = readCodexNotificationItem(notification.params);
          if (item?.type === "dynamicToolCall") {
            await acknowledgeCompletedDynamicTool(item, turnId);
          }
          if (item?.type === "userMessage" && typeof item.clientId === "string") {
            steeringQueueRef.current?.confirmConsumed(item.clientId);
          }
        }
        if (
          isCodexTurnAbortMarkerNotification(notification, {
            currentPromptTexts: [turnState.codexTurnPromptText],
          })
        ) {
          state.sawCodexInterruptMarker = true;
        }
      }
      await projector.handleNotification(notification);
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
      for (const observe of nativeItemObservers) {
        observe();
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
