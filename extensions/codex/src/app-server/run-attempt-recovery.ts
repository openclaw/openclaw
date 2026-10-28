import { isDeepStrictEqual } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import { claimCodexAppServerLiveThread } from "./client-runtime.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadResumeResponse,
} from "./protocol-validators.js";
import { isJsonObject, type CodexThread, type CodexTurn } from "./protocol.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { getCodexAppServerTurnRouter, type CodexThreadRouteReservation } from "./turn-router.js";

/** Rejoin a transport-lost turn only while its original attempt still owns execution. */
export async function recoverCodexAttemptConnection(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  disconnectedRoute: CodexThreadRouteReservation,
  activateRoute: (route: CodexThreadRouteReservation) => Promise<void>,
): Promise<void> {
  const { state, prompt } = resources;
  const { connection } = prompt.context.runtime;
  const { bindingStore, bindingIdentity, runAbortController, authority } = connection;
  const previous = state.thread;
  const previousClient = state.client;
  const turnId = turnRuntime.turnIdRef.current;
  const acquire = state.acquireRecoveryClient;
  // Fresh thread/start attempts own a reserved route without a retained-subscription
  // handle. Recovery requires that exact admitted route, the live host/run authority,
  // and the unchanged physical binding; thread identifiers alone never admit work.
  if (
    !turnId ||
    !acquire ||
    state.turnRoute !== disconnectedRoute ||
    !state.routeActivated ||
    disconnectedRoute.threadId !== previous.threadId ||
    !disconnectedRoute.signal.aborted ||
    !previousClient.getCloseError()
  ) {
    throw new Error("Codex disconnected without a recoverable active-turn owner");
  }
  const assertCurrent = () => {
    runAbortController.signal.throwIfAborted();
    connection.assertCurrent();
    if (
      turnRuntime.state.completed ||
      turnRuntime.turnIdRef.current !== turnId ||
      !isSameCodexAppServerThreadOwner(bindingStore.read(bindingIdentity), state.thread)
    ) {
      throw new Error("Codex recovery lost its original attempt authority");
    }
  };
  const readOwnedTurn = (thread: CodexThread): CodexTurn => {
    assertCurrent();
    assertCodexThreadAcceptsDirectInput(thread);
    const turns = thread.turns ?? [];
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (
      thread.id !== previous.threadId ||
      thread.status?.type === "notLoaded" ||
      !turn ||
      turns.some((candidate) => candidate.status === "inProgress" && candidate.id !== turnId) ||
      (turn.status !== "inProgress" && !isTerminalTurnStatus(turn.status))
    ) {
      throw new Error("The original Codex execution is no longer available for safe reconnection");
    }
    return turn;
  };
  assertCurrent();
  turnRuntime.state.recoveredTurnId = turnId;
  const acquired = await acquire(runAbortController.signal);
  let adopted = false;
  let detachRequestResolution: (() => void) | undefined;
  const admitted = createDeferred<void>();
  void admitted.promise.catch(() => {});
  let binding: Promise<void> | undefined;
  try {
    assertCurrent();
    if (
      !previousClient.getRuntimeIdentity() ||
      acquired.client === previousClient ||
      acquired.client.getCloseError() ||
      !isDeepStrictEqual(previousClient.getRuntimeIdentity(), acquired.client.getRuntimeIdentity())
    ) {
      throw new Error("Codex recovery selected a different or unavailable runtime");
    }
    const options = {
      signal: runAbortController.signal,
      timeoutMs: connection.appServer.requestTimeoutMs,
      assertCurrent,
      withCurrent: authority.withCurrent,
    };
    const { thread } = await acquired.client.request(
      "thread/read",
      { threadId: previous.threadId, includeTurns: true },
      options,
    );
    readOwnedTurn(thread);
    // Native replays retain their request IDs. Resolution can arrive while the
    // route's admission barrier still blocks the replay handler. It may revoke
    // an original known tool, but can never admit a new execution.
    detachRequestResolution = acquired.client.addNotificationHandler((notification) => {
      if (notification.method !== "serverRequest/resolved" || !isJsonObject(notification.params)) {
        return;
      }
      const { threadId, requestId } = notification.params;
      if (
        threadId !== previous.threadId ||
        (typeof requestId !== "string" && typeof requestId !== "number")
      ) {
        return;
      }
      const known = turnRuntime.dynamicToolRequestIdentities.get(requestId);
      if (
        known?.threadId === threadId &&
        known.turnId === turnId &&
        turnRuntime.pendingDynamicToolAbortControllers.has(known.controller)
      ) {
        known.controller.abort(new CodexServerRequestResolvedError());
      }
    });
    await resources.releaseCurrentRoute();
    assertCurrent();
    state.releaseSharedClientLease?.();
    state.releaseSharedClientLease = acquired.release;
    state.client = acquired.client;
    adopted = true;
    state.turnRouter = getCodexAppServerTurnRouter(acquired.client);
    const route = state.turnRouter.reserveThread({ threadId: previous.threadId });
    state.turnRoute = route;
    await activateRoute(route);
    const detachAbort = state.detachRouteAbort;
    const removeRequestResolution = detachRequestResolution;
    state.detachRouteAbort = () => {
      removeRequestResolution();
      detachAbort?.();
    };
    detachRequestResolution = undefined;
    route.armTurn();
    // Requests may replay immediately after the resume response. Install their route
    // first; terminal projection waits until the replacement binding is committed.
    binding = route.bindTurn(turnId, { beforeNotifications: admitted.promise });
    void binding.catch(() => {});
    const response = assertCodexThreadResumeResponse(
      await acquired.client.request("thread/resume", { threadId: previous.threadId }, options),
    );
    const recoveredTurn = readOwnedTurn(response.thread);
    const closeError = acquired.client.getCloseError();
    if (closeError) {
      throw closeError;
    }
    const ownership = await claimCodexAppServerLiveThread(acquired.client, previous.threadId);
    if (!ownership) {
      throw new Error("Codex recovered thread is already claimed by another attempt");
    }
    const clientId = acquired.client.getInstanceId();
    const committed = await bindingStore
      .mutate(
        bindingIdentity,
        {
          kind: "patch",
          threadId: previous.threadId,
          clientId: previous.clientId,
          patch: { clientId },
        },
        () => {
          runAbortController.signal.throwIfAborted();
          connection.assertCurrent();
        },
        authority,
      )
      .catch((error: unknown) => {
        ownership.forget();
        throw error;
      });
    if (!committed) {
      ownership.forget();
      throw new Error("Codex recovery lost the conversation binding before publication");
    }
    state.thread = { ...previous, clientId, liveThreadOwnership: ownership };
    assertCurrent();
    await resources.registerNativeSubagentMonitor(previous.threadId);
    assertCurrent();
    if (isTerminalTurnStatus(recoveredTurn.status)) {
      // Its resolution notification may have been lost with the old socket.
      // Revoke only still-pending work before projecting items that join it.
      for (const controller of turnRuntime.pendingDynamicToolAbortControllers) {
        controller.abort(new CodexServerRequestResolvedError());
      }
    }
    turnRuntime.state.recoveredProjectionDrain = Promise.all([
      turnRuntime.state.recoveredProjectionDrain,
      disconnectedRoute.drainAccepted(),
    ]).then(() => {});
    admitted.resolve();
    await binding;
    const scope = { threadId: previous.threadId, turnId };
    if (isTerminalTurnStatus(recoveredTurn.status) && !turnRuntime.state.completed) {
      // The controller obtains one final full history after all old projection work
      // settles. Resume's live snapshot can omit canonical-before-legacy messages.
      const terminal = { ...recoveredTurn, items: [] };
      if (!isJsonObject(terminal)) {
        throw new Error("Codex turn completion payload is not a JSON object");
      }
      const notification = {
        method: "turn/completed",
        params: { threadId: previous.threadId, turn: terminal },
      };
      notifications.noteNotificationReceived(notification, scope, Date.now());
      await notifications.enqueueNotification(notification, scope);
    }
    const finalCloseError = acquired.client.getCloseError();
    if (finalCloseError && !turnRuntime.state.completed) {
      throw finalCloseError;
    }
    resources.trajectoryRecorder?.recordEvent("turn.connection_recovered", scope);
  } catch (error) {
    // A rejected owner must never publish buffered native output as this run's result.
    admitted.reject(error);
    throw error;
  } finally {
    detachRequestResolution?.();
    if (!adopted) {
      acquired.release();
    }
  }
}
