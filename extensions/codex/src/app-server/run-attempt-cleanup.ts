import { clearActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import { terminateCodexBackgroundTerminals } from "./attempt-client-cleanup.js";
import { scheduleCodexNativeHookRelayUnregister } from "./native-hook-relay.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  isSameCodexAppServerThreadOwner,
  withExclusiveCodexAppServerThread,
} from "./thread-ownership.js";

export async function cleanupCodexAttempt(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
  activeTurn: CodexAttemptActiveTurn,
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
    retainThreadSubscription,
    releaseThreadSubscription,
    runCleanupStep,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, runAbortController, terminalState, bindingStore, bindingIdentity } =
    connection;
  const { state, steeringQueueRef, userInputBridgeRef, deadlines } = turnRuntime;
  const {
    maybeEmitFastModeAutoResetBestEffort,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
  } = lifecycle;
  const { codexModelCallDiagnostics } = requestRuntime;
  const { activeTurnId, abortListener, handle, freezeRunTerminalOutcome } = activeTurn;
  resourceState.releaseInferenceContext?.();
  resourceState.releaseInferenceContext = undefined;
  // Exact-thread cron authority exists only while this creator turn owns the
  // live client/thread. Retained model callbacks must fail after cleanup begins.
  prompt.context.attemptTools.scheduledAppAuthoritySourceRef.current = undefined;
  // Finalization can throw before freezing. Close cancellation admission before
  // any teardown await so it cannot replace the cleanup promise being joined.
  freezeRunTerminalOutcome();
  // Finalization already owns the bounded checkpoint join. Exceptional exits
  // still fence immediately, without restarting a timed-out settlement's wait.
  const projectionClose = state.projectionClosed
    ? undefined
    : activeTurn.activeProjector.closeProjection();
  state.projectionClosed = true;
  const checkpointCleanup = projectionClose
    ? runCleanupStep("codex-transcript-checkpoint", () => projectionClose)
    : undefined;
  // Join late cancellation before releasing the subscription, but do not let a
  // failed terminal RPC skip resource cleanup. Surface that failure below.
  if (params.oneShotCliRun) {
    await runCleanupStep("codex-abort-cleanup", () => state.abortCleanup);
  } else {
    await state.abortCleanup?.catch(() => {});
  }
  if (params.oneShotCliRun) {
    await runCleanupStep("codex-one-shot-terminals", () =>
      terminateCodexBackgroundTerminals(resourceState.client, resourceState.thread.threadId, true),
    );
  }
  try {
    await state.pluginRuntimeRefreshStop;
    steeringQueueRef.current?.cancel();
    if (params.isFinalFallbackAttempt !== false) {
      await maybeEmitFastModeAutoResetBestEffort();
    }
    codexModelCallDiagnostics.emitError(
      "codex app-server run completed without model-call terminal event",
    );
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
      ...buildLifecycleTerminalMeta({
        aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
        timedOut: state.timeout !== undefined,
      }),
    });
    if (trajectoryRecorder && !resourceState.trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status:
          state.timeout || (runAbortController.signal.aborted && !state.clientClosedAbort)
            ? "interrupted"
            : "cleanup",
        threadId: resourceState.thread.threadId,
        turnId: activeTurnId,
        timedOut: state.timeout !== undefined,
        aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
      });
    }
    await runCleanupStep("codex-trajectory-flush", () => trajectoryRecorder?.flush());
    const pluginRuntimeRefreshing =
      state.pluginRuntimeRefreshStop !== undefined &&
      !runAbortController.signal.aborted &&
      terminalState.settledTurnStatus === "completed";
    const retainLiveIncognitoThread =
      !pluginRuntimeRefreshing &&
      (terminalState.settledTurnStatus === "completed" ||
        (state.permissionChangeRestart === "confirmed" && !params.abortSignal?.aborted)) &&
      isIncognitoSessionKey(params.sessionKey);
    // Incognito retains its creation policy without idle eviction.
    // Ordinary failed turns keep loaded configuration too: native unsubscribe delays unload.
    // Retain that configuration owner so later input can reuse the same thread.
    const retainedOrdinaryThread =
      !pluginRuntimeRefreshing &&
      ((retainLiveIncognitoThread &&
        resourceState.thread.liveThreadEphemeralPolicy !== undefined) ||
        (terminalState.settledTurnStatus !== undefined &&
          !isIncognitoSessionKey(params.sessionKey) &&
          params.cleanupBundleMcpOnRunEnd !== true &&
          resourceState.thread.liveThreadConfigFingerprint !== undefined &&
          !resourceState.thread.ringZeroConfigFingerprint)) &&
      (await retainThreadSubscription());
    // Nonordinary incognito lifetimes retain their previous live-only ownership.
    const retainLiveThread =
      retainedOrdinaryThread ||
      (retainLiveIncognitoThread && resourceState.thread.liveThreadEphemeralPolicy === undefined);
    if (pluginRuntimeRefreshing) {
      // Keep the exact binding authoritative until unsubscribe succeeds; a failed
      // stop or a replacement owner must never become a fresh-thread handoff.
      await withExclusiveCodexAppServerThread({
        bindingStore,
        identity: bindingIdentity,
        threadId: resourceState.thread.threadId,
        run: () =>
          bindingStore.withLease(bindingIdentity, async () => {
            if (
              !isSameCodexAppServerThreadOwner(
                bindingStore.read(bindingIdentity),
                resourceState.thread,
              )
            ) {
              throw new Error("Codex plugin refresh lost its managed thread binding.");
            }
            if (!(await releaseThreadSubscription(connection.assertCurrent))) {
              throw new Error("Plugin reload could not release the previous Codex thread.");
            }
            if (
              !(await bindingStore.mutate(
                bindingIdentity,
                {
                  kind: "clear",
                  threadId: resourceState.thread.threadId,
                },
                connection.assertCurrent,
              ))
            ) {
              throw new Error("Codex plugin refresh lost its managed thread binding.");
            }
          }),
      });
    } else {
      // Codex keeps approvals in its native session; independent conversations
      // must retain their own subscriptions instead of evicting one another.
      const bindingReleased =
        isIncognitoSessionKey(params.sessionKey) && !retainLiveThread
          ? await bindingStore.mutate(bindingIdentity, {
              kind: "clear",
              threadId: resourceState.thread.threadId,
            })
          : true;
      // Only explicitly retained live threads may skip the next thread/resume.
      if (!retainLiveThread) {
        // Clear first: if a newer owner won the binding, its live subscription must remain intact.
        if (bindingReleased) {
          if (!(await releaseThreadSubscription())) {
            if (params.oneShotCliRun) {
              await runCleanupStep("codex-one-shot-unsubscribe", async () => {
                throw new Error("Codex one-shot thread unsubscribe was not confirmed");
              });
            }
          }
        }
      }
    }
  } finally {
    if (resourceState.thread.liveThreadOwnership) {
      // A failed retention/finalization still owes settlement of its warm claim.
      // Already-retained or released subscriptions are no-ops at the resource owner.
      await runCleanupStep("codex-unsettled-subscription", async () => {
        await releaseThreadSubscription();
      });
    }
    await runCleanupStep("codex-user-input-cancel", () =>
      userInputBridgeRef.current?.cancelPending(),
    );
    await runCleanupStep("codex-turn-deadline-clear", () => deadlines.dispose());
    await prompt.context.attemptTools.disposeTools(
      terminalState.settledTurnStatus === "completed"
        ? "completion"
        : state.timeout
          ? "timeout"
          : runAbortController.signal.aborted
            ? "cancel"
            : "error",
    );
    await runCleanupStep("codex-route-release", releaseCurrentRoute);
    await checkpointCleanup;
    await runCleanupStep(
      "codex-shared-client-release",
      releaseSharedClientLeaseAndRetireOneShotClient,
    );
    const nativeHookRelay = resourceState.nativeHookRelay;
    resourceState.nativeHookRelay = undefined;
    await runCleanupStep("codex-native-hook-relay-release", async () => {
      if (!nativeHookRelay) {
        return;
      }
      if (state.shouldDelayNativeHookRelayUnregister && !params.oneShotCliRun) {
        // Native hook subprocesses can finish shortly after turn completion.
        scheduleCodexNativeHookRelayUnregister({
          relay: nativeHookRelay,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        });
      } else {
        nativeHookRelay.unregister();
      }
      await nativeHookRelay.drain();
    });
    await runCleanupStep("codex-sandbox-release", releaseSandboxExecEnvironment);
    await runCleanupStep("codex-abort-listener-remove", () => {
      runAbortController.signal.removeEventListener("abort", abortListener);
    });
    await runCleanupStep("codex-steering-cancel", () => steeringQueueRef.current?.cancel());
    await runCleanupStep("codex-reply-backend-detach", () =>
      params.replyOperation?.detachBackend(handle),
    );
    await runCleanupStep("codex-active-run-clear", () => {
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
    });
  }
  await state.abortCleanup;
}
