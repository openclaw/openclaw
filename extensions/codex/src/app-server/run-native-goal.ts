import {
  clearActiveEmbeddedRun,
  type AgentHarnessNativeGoal,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import {
  assertCodexNativeGoalMatches,
  reconcileCodexNativeGoalBudget,
} from "./native-goal-control.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import { isJsonObject, type CodexThreadGoal } from "./protocol.js";
import {
  activateCodexAttemptTurn,
  type CodexAttemptActiveTurn,
} from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import {
  prepareCodexAttemptTurnRequest,
  type CodexStartedTurn,
} from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { waitForPromiseOrAbort } from "./timeout.js";

/** One admitted run owns all autonomous native turns, not a host reprompt loop. */
export async function runCodexNativeGoalPursuit(
  resources: StartedCodexAttemptResources,
  goal: AgentHarnessNativeGoal,
): Promise<EmbeddedRunAttemptResult> {
  const { state: native } = resources;
  const { connection } = resources.prompt.context.runtime;
  const { params, runAbortController } = connection;
  let threadId = native.thread.threadId;
  const client = native.client;
  let wake = createDeferred<void>();
  const starts: CodexStartedTurn[] = [];
  const seen = new Set<string>();
  let latestTurnId: string | undefined;
  let owned = false;
  let stopping: Promise<void> | undefined;
  let pausing: Promise<void> | undefined;
  const rejectedTurns = new Map<string, Promise<void>>();
  let active: CodexAttemptActiveTurn | undefined;
  let retiredActive: CodexAttemptActiveTurn | undefined;
  const priorTurns: EmbeddedRunAttemptResult[] = [];
  let turnRuntime = createCodexAttemptTurnState(resources);
  let lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
  let request: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>> | undefined;
  let finalCleanup = false;
  let closing = false;
  let nativeGoal: CodexThreadGoal | null = null;
  let goalChanged = false;
  const notify = () => {
    wake.resolve();
  };
  // This listener observes receipts only. The turn router owns ordered projection
  // and holds successor tool requests until their exact turn has been admitted.
  const detach = client.addNotificationHandler((notification) => {
    if (!isJsonObject(notification.params) || notification.params.threadId !== threadId) {
      return;
    }
    if (notification.method === "turn/started") {
      const response = assertCodexTurnStartResponse({ turn: notification.params.turn });
      const startedTurnId = response.turn.id;
      if (!seen.has(startedTurnId)) {
        try {
          goal.assertCurrent();
          if (goal.readToolStatus?.()) {
            // Native scheduling can beat the old turn's finalizer. Retain exact
            // cancellation custody, but never rotate model/process/hook owners.
            void rejectSuccessor(startedTurnId).catch(() => undefined);
            notify();
            return;
          }
          native.admitNativeGoalTurn?.(startedTurnId);
        } catch (error) {
          runAbortController.abort(error);
          notify();
          return;
        }
        latestTurnId = startedTurnId;
        seen.add(startedTurnId);
        starts.push({ turn: response, upstreamUserText: "", nativeContinuation: true });
      }
      notify();
    } else if (
      notification.method === "thread/goal/updated" ||
      notification.method === "thread/goal/cleared"
    ) {
      goalChanged = true;
      notify();
    }
  });
  const assertCurrent = () => {
    connection.assertCurrent();
    goal.assertCurrent();
  };
  const detachClose = client.addCloseHandler(() => {
    if (closing) {
      return;
    }
    runAbortController.abort(new Error("Native goal app-server closed before pursuit settled"));
    notify();
  });
  const readGoal = async () => {
    const result = await client.request(
      "thread/goal/get",
      { threadId },
      {
        assertCurrent,
        signal: runAbortController.signal,
      },
    );
    assertCodexNativeGoalMatches(result.goal, goal);
    nativeGoal = result.goal;
    return nativeGoal;
  };
  const report = async () => {
    if (!nativeGoal) {
      throw new Error("The native Codex goal was cleared during its admitted pursuit");
    }
    await goal.onStatus({
      status:
        nativeGoal.status === "usageLimited" || nativeGoal.status === "budgetLimited"
          ? "blocked"
          : nativeGoal.status,
      ...(nativeGoal.status === "usageLimited" || nativeGoal.status === "budgetLimited"
        ? { reason: `Codex native goal is ${nativeGoal.status}` }
        : {}),
    });
  };
  const closeAfterFailedStop = async (error: unknown): Promise<never> => {
    // Keep D2's exact client and resource custody until shutdown is confirmed.
    runAbortController.abort(error);
    native.nativeGoalCleanupUnsettled = true;
    const receipt = await client.closeAndWait();
    native.nativeGoalCleanupUnsettled = !receipt.exited || receipt.cleanup === "uncertain";
    if (native.nativeGoalCleanupUnsettled) {
      throw new AggregateError(
        [error],
        `Native goal shutdown unsettled (exited=${receipt.exited}, cleanup=${receipt.cleanup}); custody retained`,
      );
    }
    throw error;
  };
  const pause = () =>
    (pausing ??= (async () => {
      if (!owned) {
        return;
      }
      try {
        // Teardown may pause this reconciled goal after revocation, never activate it.
        const current = await client.request("thread/goal/get", { threadId });
        assertCodexNativeGoalMatches(current.goal, goal);
        if (current.goal?.status === "active") {
          await client.request("thread/goal/set", {
            threadId,
            status: "paused",
            origin: "automatic",
          });
        }
      } catch (error) {
        await closeAfterFailedStop(error);
      }
      // Coalesce concurrent suspension, but recheck at final stop: the current
      // native turn may have changed its own goal again while finishing.
      pausing = undefined;
    })());
  const rejectSuccessor = (turnId: string): Promise<void> => {
    const pending = rejectedTurns.get(turnId);
    if (pending) {
      return pending;
    }
    const cleanup = (async () => {
      await pause();
      try {
        if (!(await interruptCodexTurnAndWaitBestEffort(client, { threadId, turnId }))) {
          throw new Error("Could not confirm rejected native successor cancellation");
        }
        await resources.nativeProcessAuthority?.cancelTurn(client, threadId, turnId);
      } catch (error) {
        await closeAfterFailedStop(error);
      }
    })();
    rejectedTurns.set(turnId, cleanup);
    return cleanup;
  };
  const suspendToolPursuit = async () => {
    // The current turn must finish its answer. Only queued successors are cancelled.
    for (const start of starts.splice(0)) {
      if (start.turn.turn.id !== turnRuntime.turnIdRef.current) {
        void rejectSuccessor(start.turn.turn.id).catch(() => undefined);
      }
    }
    notify();
    await pause();
    await Promise.all(rejectedTurns.values());
  };
  const detachToolStatus = goal.subscribeToolStatus?.(suspendToolPursuit);
  const stop = () =>
    (stopping ??= (async () => {
      if (!owned) {
        return;
      }
      await pause();
      if (
        latestTurnId &&
        !(await interruptCodexTurnAndWaitBestEffort(client, { threadId, turnId: latestTurnId }))
      ) {
        await closeAfterFailedStop(new Error("Could not confirm native goal turn cancellation"));
      }
      await Promise.all(rejectedTurns.values());
    })());
  native.pauseNativeGoal = stop;
  native.nativeGoalPursuing = true;
  // Per-turn settlement disposes its deadline. Preserve the admitted run budget
  // across that boundary and native idle/continuation scheduling as well.
  const remaining = params.timeoutMs - (Date.now() - connection.attemptStartedAt);
  const deadline = setTimeout(
    () => runAbortController.abort(new Error("Native goal execution budget timed out")),
    Math.max(1, remaining),
  );
  deadline.unref?.();
  try {
    const existing = await readGoal();
    owned = true;
    if (native.thread.pluginAppPolicyContext) {
      resources.prompt.context.attemptTools.scheduledAppAuthoritySourceRef.current = {
        client,
        threadId,
        policyContext: native.thread.pluginAppPolicyContext,
        configCwd: connection.effectiveCwd,
      };
    }
    if (existing?.status === "active") {
      throw new Error(
        "Codex restored an active goal before pursuit admission; refusing to replace its turn",
      );
    }
    // A prepared active host capability also authorizes explicit Resume of a
    // completed/blocked/limited goal. Keep its objective and lifetime counters.
    nativeGoal = await reconcileCodexNativeGoalBudget(
      client,
      threadId,
      goal,
      existing,
      assertCurrent,
      runAbortController.signal,
    );
    let next: CodexStartedTurn | undefined;
    let first = true;
    while (true) {
      assertCurrent();
      runAbortController.signal.throwIfAborted();
      const notifications = createCodexAttemptNotificationController(
        resources,
        turnRuntime,
        lifecycle,
      );
      const serverRequests = createCodexAttemptServerRequestController(
        resources,
        turnRuntime,
        lifecycle,
        notifications.waitForNativeTerminalItems,
      );
      const { ensureCurrentThreadRoute } = await prepareCodexAttemptRoute(
        resources,
        turnRuntime,
        notifications,
        serverRequests.handleServerRequest,
      );
      native.turnRoute!.enableNativeSuccessors();
      request = await prepareCodexAttemptTurnRequest(
        resources,
        turnRuntime,
        ensureCurrentThreadRoute,
        notifications.waitForActiveNativeTurnCompletion,
      );
      if (first) {
        // Every new admitted host run must bind model execution and the private
        // inference generation through turn/start. Resuming via goal/set alone
        // would retain an obsolete generation (or none). This admits the current
        // inbound turn once; only Codex schedules subsequent goal turns.
        const start = await startCodexAttemptTurn(resources, turnRuntime, notifications, request);
        if ("result" in start) {
          await goal.onStatus({
            status: "blocked",
            reason: "Codex could not start the native goal turn",
          });
          return start.result;
        }
        if (native.thread.threadId !== threadId) {
          // Preserve the existing context-engine overflow recovery. Its fresh
          // thread carries canonical history; the old native goal stays paused.
          // Only initialize an empty successor, never replace its own goal.
          threadId = native.thread.threadId;
          const recoveredGoal = await readGoal();
          if (recoveredGoal) {
            throw new Error(
              "Recovered Codex thread already has a native goal; refusing to replace it",
            );
          }
          nativeGoal = await reconcileCodexNativeGoalBudget(
            client,
            threadId,
            goal,
            null,
            assertCurrent,
            runAbortController.signal,
          );
          native.turnRoute?.enableNativeSuccessors();
        }
        next = start;
        latestTurnId = start.turn.turn.id;
        seen.add(latestTurnId);
        // Native receipt may precede the RPC response; consume that one start once.
        const index = starts.findIndex((item) => item.turn.turn.id === latestTurnId);
        if (index >= 0) {
          starts.splice(index, 1);
        }
      }
      if (first) {
        const response = await client.request(
          "thread/goal/set",
          { threadId, status: "active", origin: "automatic" },
          {
            assertCurrent,
            signal: runAbortController.signal,
          },
        );
        nativeGoal = response.goal;
        await report();
        first = false;
      }
      const waitForNext = async (): Promise<CodexStartedTurn | undefined> => {
        while (!runAbortController.signal.aborted) {
          // Install the wake barrier before the RPC to avoid losing a receipt.
          wake = createDeferred<void>();
          goalChanged = false;
          if (goal.readToolStatus?.()) {
            return undefined;
          }
          const current = await readGoal();
          if (goal.readToolStatus?.()) {
            return undefined;
          }
          const start = starts.shift();
          // A native terminal goal can follow an already accepted successor.
          // Drain that turn under admission before projecting the terminal goal.
          if (start) {
            return start;
          }
          if (!current || current.status !== "active") {
            return undefined;
          }
          if (goalChanged) {
            continue;
          }
          await waitForPromiseOrAbort(wake.promise, runAbortController.signal);
        }
        runAbortController.signal.throwIfAborted();
        return undefined;
      };
      next ??= await waitForNext();
      if (!next) {
        await report();
        return emptyGoalResult(params.sessionId);
      }
      turnRuntime.turnIdRef.current = next.turn.turn.id;
      active = activateCodexAttemptTurn(
        resources,
        turnRuntime,
        lifecycle,
        notifications,
        next,
        request.codexModelCallDiagnostics.emitResponseObserved,
      );
      next = undefined;
      let keepGoing = false;
      await active.ready;
      retiredActive = undefined; // Registration replaced the old per-turn handle.
      const result = await finalizeCodexAttempt(
        resources,
        turnRuntime,
        lifecycle,
        notifications,
        request,
        active,
        {
          continueAfterTurn: async (settled) => {
            const terminal = attemptTerminal.project(settled.terminal);
            if (
              terminal.aborted ||
              terminal.promptError ||
              terminal.timedOut ||
              runAbortController.signal.aborted ||
              turnRuntime.state.pluginRuntimeRefreshStop ||
              settled.yieldDetected
            ) {
              accumulateNativeGoalResults(settled, priorTurns);
              await stop();
              await goal.onStatus({
                status:
                  terminal.aborted ||
                  settled.yieldDetected ||
                  turnRuntime.state.pluginRuntimeRefreshStop
                    ? "paused"
                    : "blocked",
                reason: "Codex native goal turn ended before the pursuit completed",
              });
              return false;
            }
            if (goal.readToolStatus?.()) {
              await suspendToolPursuit();
              accumulateNativeGoalResults(settled, priorTurns);
              return false;
            }
            next = await waitForNext();
            keepGoing = next !== undefined;
            if (!keepGoing) {
              accumulateNativeGoalResults(settled, priorTurns);
              await report();
            }
            return keepGoing;
          },
        },
      );
      if (!keepGoing) {
        await stop();
        finalCleanup = true;
        closing = true;
        await cleanupCodexAttempt(resources, turnRuntime, lifecycle, request, active);
        active = undefined;
        return result;
      }
      // Retire only turn-local owners. Admission, tools, process, relay and thread
      // remain live; the native scheduler has already chosen the next turn.
      runAbortController.signal.removeEventListener("abort", active.abortListener);
      turnRuntime.steeringQueueRef.current?.cancel();
      await turnRuntime.userInputBridgeRef.current?.cancelPending();
      priorTurns.push(result);
      // Keep a live cancellation handle until its successor replaces it.
      retiredActive = active;
      active = undefined;
      turnRuntime.deadlines.dispose();
      native.detachRouteAbort?.();
      native.turnRoute!.rearmNativeTurn();
      native.routeActivated = false;
      turnRuntime = createCodexAttemptTurnState(resources);
      lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
    }
  } catch (error) {
    await stop().catch(() => undefined); // stop() closes the owned process if pause fails.
    try {
      await goal.onStatus({
        status: runAbortController.signal.aborted ? "paused" : "blocked",
        reason: error instanceof Error ? error.message : "Native Codex goal failed",
      });
    } catch {
      // A changed host goal is authoritative; never overwrite it during cleanup.
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    try {
      await stop();
    } finally {
      detach();
      detachClose();
      detachToolStatus?.();
      native.pauseNativeGoal = undefined;
      native.admitNativeGoalTurn = undefined;
      native.nativeGoalPursuing = false;
      turnRuntime.deadlines.dispose();
      if (retiredActive) {
        clearActiveEmbeddedRun(
          params.sessionId,
          retiredActive.handle,
          params.sessionKey,
          params.sessionFile,
          undefined,
          retiredActive.activeRunAttachment,
        );
      }
      if (!finalCleanup) {
        const cleanup = async () => {
          // A confirmed physical cleanup discharges the failed cancellation RPC;
          // do not rethrow that cached failure after the retained resources drain.
          if (native.nativeGoalCleanupUnsettled) {
            turnRuntime.state.abortCleanup = Promise.resolve();
          }
          if (active && request) {
            await cleanupCodexAttempt(resources, turnRuntime, lifecycle, request, active);
          } else {
            await resources.cleanupBeforeActiveTurn();
          }
        };
        if (native.nativeGoalCleanupUnsettled) {
          native.releaseInferenceContext?.();
          native.releaseInferenceContext = undefined;
          if (active) {
            active.freezeRunTerminalOutcome();
            runAbortController.signal.removeEventListener("abort", active.abortListener);
            clearActiveEmbeddedRun(
              params.sessionId,
              active.handle,
              params.sessionKey,
              params.sessionFile,
              undefined,
              active.activeRunAttachment,
            );
          }
          native.deferredNativeGoalCleanup = cleanup;
        } else {
          await cleanup();
        }
      }
    }
  }
}

function emptyGoalResult(sessionId: string): EmbeddedRunAttemptResult {
  return {
    terminal: attemptTerminal.normalize({}),
    sessionIdUsed: sessionId,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

/** Intermediate turns were already mirrored; preserve their accounting and replay evidence. */
function accumulateNativeGoalResults(
  result: EmbeddedRunAttemptResult,
  prior: EmbeddedRunAttemptResult[],
) {
  for (const turn of prior.toReversed()) {
    result.messagesSnapshot = [...turn.messagesSnapshot, ...result.messagesSnapshot];
    result.toolMetas = [...turn.toolMetas, ...result.toolMetas];
    result.modelIterations = (result.modelIterations ?? 0) + (turn.modelIterations ?? 0);
    result.compactionCount = (result.compactionCount ?? 0) + (turn.compactionCount ?? 0);
    result.itemLifecycle.startedCount += turn.itemLifecycle.startedCount;
    result.itemLifecycle.completedCount += turn.itemLifecycle.completedCount;
    result.replayMetadata.hadPotentialSideEffects ||= turn.replayMetadata.hadPotentialSideEffects;
    result.replayMetadata.replaySafe &&= turn.replayMetadata.replaySafe;
    if (turn.attemptUsage) {
      result.attemptUsage ??= {};
      for (const field of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoningTokens",
        "total",
      ] as const) {
        const previous = turn.attemptUsage[field];
        if (previous !== undefined) {
          result.attemptUsage[field] = (result.attemptUsage[field] ?? 0) + previous;
        }
      }
    }
  }
}
