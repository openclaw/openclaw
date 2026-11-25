import { AsyncResource } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { CodexAppServerClient } from "./client.js";
import { codexNativeSubagentHistoryConnectionFingerprint } from "./native-subagent-history-owner.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import { isJsonObject } from "./protocol.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { waitForPromiseOrAbort } from "./timeout.js";

async function recoverDisconnectedTurn(
  resources: StartedCodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  turnId: string,
  open: () => CodexAppServerClient,
) {
  const { connection, nativeExecutionPolicy } = resources.prompt.context.runtime;
  const { bindingStore, bindingIdentity, runAbortController } = connection;
  const { thread, client, turnRoute } = resources.state;
  const { threadId } = thread;
  const { state } = turnRuntime;
  const fingerprint = codexNativeSubagentHistoryConnectionFingerprint(thread);
  if (!fingerprint) {
    return;
  }
  const signal = AbortSignal.any([runAbortController.signal, AbortSignal.timeout(10_000)]);
  let reader: CodexAppServerClient | undefined;
  const read = async () => {
    await turnRoute?.drain({ afterClose: true });
    signal.throwIfAborted();
    const prepared = await bindingStore.prepareRead(bindingIdentity);
    if (!prepared) {
      return;
    }
    using binding = { read: prepared.read, [Symbol.dispose]: prepared.release };
    const withCurrent = (write: () => void) =>
      nativeExecutionPolicy.admit(() => {
        signal.throwIfAborted();
        connection.assertCurrent();
        nativeExecutionPolicy.source?.();
        const current = binding.read();
        if (
          !turnRuntime.deadlines.ownsExecutionWait() ||
          state.projectionClosed ||
          state.activeLocalProjections ||
          state.localCompletionRequested ||
          state.sawCodexInterruptMarker ||
          thread.clientId !== client.getInstanceId() ||
          !current ||
          current.preserveNativeModel ||
          !isSameCodexAppServerThreadOwner(current, thread) ||
          codexNativeSubagentHistoryConnectionFingerprint(current) !== fingerprint
        ) {
          throw new Error("Codex disconnected turn is no longer current");
        }
        write();
      }, connection.withCurrent);
    await withCurrent(() => {
      reader = open();
    });
    const peer = reader!;
    await peer.initialize();
    if (!isDeepStrictEqual(client.getRuntimeIdentity(), peer.getRuntimeIdentity())) {
      return;
    }
    const latest = async () => {
      const page = await peer.request(
        "thread/turns/list",
        { threadId, limit: 1, sortDirection: "desc", itemsView: "full" },
        { signal, withCurrent },
      );
      const turn = Array.isArray(page.data) && page.data.length === 1 ? page.data[0] : undefined;
      return turn?.id === turnId && (turn.threadId === undefined || turn.threadId === threadId)
        ? turn
        : undefined;
    };
    let turn = await latest();
    // The external server may still be finishing the accepted request. Bound
    // history replays even on older servers which scan an entire rollout.
    if (turn?.status === "inProgress") {
      await sleepWithAbort(5_000, signal, { ref: false });
      turn = await latest();
    }
    // Legacy history can reconstruct "completed" without a completion event.
    if (
      turn?.status !== "completed" ||
      turn.error != null ||
      !Number.isSafeInteger(turn.completedAt) ||
      !turn.completedAt ||
      turn.completedAt < (turn.startedAt ?? 0) ||
      !isJsonObject(turn) ||
      turn.itemsView !== "full" ||
      !Array.isArray(turn.items)
    ) {
      return;
    }
    const answer = resources.projectorRef.current?.resolveHistoryAnswer(turn);
    if (!answer) {
      return;
    }
    // Match the native terminal summary. Never replay tool or async-delivery
    // events from history. The projector retains unknown outcomes for gaps.
    const summary = { ...turn, items: [answer], itemsView: "summary" };
    if (!isJsonObject(summary)) {
      return;
    }
    const notification = prepareCodexServerNotification({
      method: "turn/completed",
      params: { threadId, turn: summary },
    });
    if (!notification.completedTurn || notification.turnId !== turnId) {
      return;
    }
    await withCurrent(() => {
      resources.projectorRef.current!.settlement.turnTainted = true;
      notifications.noteNotificationReceived(notification, { threadId, turnId }, Date.now());
      void notifications.enqueueNotification(notification);
    });
  };
  try {
    await waitForPromiseOrAbort(read(), signal);
  } finally {
    reader?.close();
  }
}

export async function prepareCodexAttemptRoute(
  resources: StartedCodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  handleServerRequest: ReturnType<
    typeof createCodexAttemptServerRequestController
  >["handleServerRequest"],
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    registerNativeSubagentMonitor,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { runAbortController } = connection;
  const { state, turnIdRef, completeTurn } = turnRuntime;
  const { noteNotificationReceived, enqueueNotification } = notifications;
  const ensureCurrentThreadRoute = async () => {
    if (resourceState.turnRoute?.threadId !== resourceState.thread.threadId) {
      await releaseCurrentRoute();
      resourceState.turnRoute = resourceState.turnRouter.reserveThread({
        threadId: resourceState.thread.threadId,
      });
    }
    if (!resourceState.routeActivated) {
      if (!resourceState.nativeSubagentMonitor) {
        await registerNativeSubagentMonitor(resourceState);
      }
      const route = resourceState.turnRoute;
      const settled = () =>
        state.completed ||
        state.terminalTurnNotificationQueued ||
        runAbortController.signal.aborted;
      const failClosedRoute = () => {
        if (settled()) {
          return;
        }
        const reasonText = formatErrorMessage(route.signal.reason);
        const closedClient = reasonText.includes("turn router closed");
        const closeCause =
          route.signal.reason instanceof Error && route.signal.reason.cause instanceof Error
            ? route.signal.reason.cause
            : undefined;
        state.clientClosedPromptError = closedClient
          ? "codex app-server client closed before turn completed"
          : `codex app-server turn route closed before turn completed: ${reasonText}`;
        state.clientClosedDiagnostic =
          closedClient && closeCause ? formatErrorMessage(closeCause) : undefined;
        state.clientClosedAbort = closedClient;
        const activeTurnId = turnIdRef.current;
        if (activeTurnId) {
          trajectoryRecorder?.recordEvent("turn.client_closed", {
            threadId: resourceState.thread.threadId,
            turnId: activeTurnId,
          });
        }
        embeddedAgentLog.warn(state.clientClosedPromptError, {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          ...(state.clientClosedDiagnostic ? { transportError: state.clientClosedDiagnostic } : {}),
        });
        runAbortController.abort(closedClient ? "client_closed" : "turn_route_closed");
        completeTurn();
      };
      const onAbort = AsyncResource.bind(() => {
        if (settled()) {
          return;
        }
        const { thread, client } = resourceState;
        const open = client.getDisconnectedPeer?.();
        if (
          !open ||
          !turnIdRef.current ||
          !state.projectionBound ||
          state.activeAppServerTurnRequests ||
          thread.preserveNativeModel ||
          thread.connectionScope ||
          thread.conversationIncognito ||
          connection.params.oneShotCliRun ||
          thread.liveThreadEphemeralPolicy ||
          thread.lifecycle.preserveExistingBinding
        ) {
          failClosedRoute();
          return;
        }
        void recoverDisconnectedTurn(
          resources,
          turnRuntime,
          notifications,
          turnIdRef.current,
          open,
        ).then(failClosedRoute, failClosedRoute);
      });
      route.signal.addEventListener("abort", onAbort, { once: true });
      if (route.signal.aborted) {
        onAbort();
      }
      resourceState.detachRouteAbort = () => route.signal.removeEventListener("abort", onAbort);
      await resourceState.turnRoute.activate({
        onNotificationReceived: noteNotificationReceived,
        onNotification: enqueueNotification,
        onRequest: handleServerRequest,
      });
      resourceState.routeActivated = true;
    }
    return resourceState.turnRoute;
  };
  await ensureCurrentThreadRoute();
  return { ensureCurrentThreadRoute };
}
