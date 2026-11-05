import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAppServerClient } from "./client.js";
import { codexPrewriteRejectionCause } from "./rpc-error.js";
import { activateCodexAttemptTurn } from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { reportCodexBackgroundCleanupFailure } from "./run-attempt-lifecycle.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import { runCodexNativeGoalPursuit } from "./run-native-goal.js";
import { retainIsolatedCodexCloseCleanup } from "./shared-client-lifecycle.js";

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParamsV2,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  if (
    params.requireWorkspaceOnly === true &&
    (params.disableTools === true ||
      typeof params.hostCapabilities?.createToolSurfaceAsync !== "function")
  ) {
    throw new Error("Codex required-root execution requires an enabled host-mediated tool surface");
  }
  const nativeGoal = await params.hostCapabilities.prepareNativeGoal?.();
  nativeGoal?.assertCurrent();
  const nativeParams = {
    ...params,
    ...(nativeGoal
      ? {
          nativeGoal,
          abortSignal: params.abortSignal
            ? AbortSignal.any([params.abortSignal, nativeGoal.signal])
            : nativeGoal.signal,
        }
      : {}),
  };
  const preparation = createCodexAttemptPreparationTiming(params);
  const connection = await preparation.measure("connection", () =>
    prepareCodexAttemptConnection({
      params: params.continuation
        ? { ...nativeParams, prompt: `${params.continuation.prompt}\n\n${params.prompt}` }
        : nativeParams,
      options,
    }),
  );
  let deferredClient: CodexAppServerClient | undefined;
  const deferredCleanup: Array<() => Promise<void> | void> = [];
  const cleanupOrRetain = async (cleanup: () => Promise<void> | void) => {
    if (deferredClient) {
      deferredCleanup.push(cleanup);
    } else {
      await cleanup();
    }
  };
  try {
    const runtime = await preparation.measure("runtime", () =>
      prepareCodexAttemptRuntime(connection),
    );
    try {
      const attemptTools = await preparation.measure("tools", () =>
        prepareCodexAttemptTools(runtime),
      );
      // Tool preparation transfers these leases before context or native startup can fail.
      try {
        const attemptContext = await preparation.measure("context", () =>
          prepareCodexAttemptContext(runtime, attemptTools),
        );
        const attemptPrompt = await preparation.measure("prompt", () =>
          prepareCodexAttemptPrompt(attemptContext),
        );
        const resources = prepareCodexAttemptResources(attemptPrompt);
        // This turn's claimed children make the yield; otherwise report native
        // children of earlier turns, whose completion still resumes the session.
        attemptTools.runtimeYieldCompletionClaim.current = () => {
          if (resources.state.nativeHookRelay?.hasClaimedDirectChild()) {
            return true;
          }
          const pendingChildren =
            resources.state.nativeSubagentMonitor?.listPendingChildren() ?? [];
          return pendingChildren.length > 0 ? { pendingChildren } : false;
        };
        let activeTurnOwnsCleanup = false;
        try {
          const startedResources = await preparation.measure("runtime-start", () =>
            startCodexAttemptRuntime(resources),
          );

          if (nativeGoal) {
            activeTurnOwnsCleanup = true;
            return await runCodexNativeGoalPursuit(startedResources, nativeGoal);
          }
          const turnRuntime = createCodexAttemptTurnState(startedResources);
          try {
            const lifecycle = createCodexAttemptLifecycleController(startedResources, turnRuntime);
            const notifications = createCodexAttemptNotificationController(
              startedResources,
              turnRuntime,
              lifecycle,
            );
            const serverRequests = createCodexAttemptServerRequestController(
              startedResources,
              turnRuntime,
              lifecycle,
              notifications.waitForNativeTerminalItems,
            );
            const { ensureCurrentThreadRoute } = await preparation.measure("thread-route", () =>
              prepareCodexAttemptRoute(
                startedResources,
                turnRuntime,
                notifications,
                serverRequests.handleServerRequest,
              ),
            );
            const turnRequest = await preparation.measure("turn-request", () =>
              prepareCodexAttemptTurnRequest(
                startedResources,
                turnRuntime,
                ensureCurrentThreadRoute,
                notifications.waitForActiveNativeTurnCompletion,
              ),
            );
            preparation.ready();
            const turnStart = await startCodexAttemptTurn(
              startedResources,
              turnRuntime,
              notifications,
              turnRequest,
            );
            if ("result" in turnStart) {
              connection.assertModelExecutionCurrent();
              return turnStart.result;
            }
            const activeTurn = activateCodexAttemptTurn(
              startedResources,
              turnRuntime,
              lifecycle,
              notifications,
              turnStart,
              turnRequest.codexModelCallDiagnostics.emitResponseObserved,
            );
            activeTurnOwnsCleanup = true;
            let finalizedResult: EmbeddedRunAttemptResult | undefined;
            try {
              try {
                await activeTurn.ready;
                finalizedResult = await finalizeCodexAttempt(
                  startedResources,
                  turnRuntime,
                  lifecycle,
                  notifications,
                  turnRequest,
                  activeTurn,
                );
              } finally {
                await cleanupCodexAttempt(
                  startedResources,
                  turnRuntime,
                  lifecycle,
                  turnRequest,
                  activeTurn,
                );
              }
            } catch (error) {
              // Rejected cleanup admission must not hide the model permission loss
              // behind a secondary subscription-release error.
              connection.assertModelExecutionCurrent();
              if (!finalizedResult || !turnRuntime.state.pluginRuntimeRefreshStop) {
                throw error;
              }
              // A failed handoff still owns completed effects. Return their replay
              // evidence rather than throwing them away at the cleanup boundary.
              const original = attemptTerminal.project(finalizedResult.terminal).promptError;
              finalizedResult.terminal = attemptTerminal.merge(finalizedResult.terminal, {
                kind: "failed",
                source: "prompt",
                error: new AggregateError(
                  original ? [original, error] : [error],
                  "Plugin runtime changed, but native continuation failed. Inspect the existing thread before continuing; do not repeat completed actions.",
                ),
              });
              delete finalizedResult.pluginRuntimeRefreshMessages;
              delete finalizedResult.settledTurnFinalizationContext;
            }
            // Cleanup retires the execution lease; only then can device loss no longer
            // race the final result captured during asynchronous terminal processing.
            if (
              startedResources.state.executionDisconnectError &&
              !connection.terminalState.explicitCancellationObserved
            ) {
              throw startedResources.state.executionDisconnectError;
            }
            connection.assertModelExecutionCurrent();
            return finalizedResult;
          } finally {
            turnRuntime.deadlines.dispose();
          }
        } finally {
          if (resources.state.nativeGoalCleanupUnsettled) {
            deferredClient = resources.state.client;
            if (resources.state.deferredNativeGoalCleanup) {
              deferredCleanup.push(resources.state.deferredNativeGoalCleanup);
            }
          }
          if (!activeTurnOwnsCleanup) {
            await resources.cleanupBeforeActiveTurn();
          }
        }
      } finally {
        await cleanupOrRetain(() =>
          attemptTools.disposeTools(
            connection.runAbortController.signal.aborted ? "cancel" : "error",
          ),
        );
      }
    } finally {
      await cleanupOrRetain(() => runtime.nativeExecutionPolicy.release());
    }
  } catch (error) {
    throw codexPrewriteRejectionCause(error);
  } finally {
    // Preparation can fail before the active turn installs its terminal freeze.
    try {
      connection.cancellation.dispose();
      await cleanupOrRetain(() => connection.releaseModelExecution());
      await cleanupOrRetain(() => connection.releaseSandboxContext());
    } finally {
      await cleanupOrRetain(() => connection.releaseBindingAuthority());
      if (deferredClient) {
        retainIsolatedCodexCloseCleanup(
          deferredClient,
          async () => {
            // Shift only after settlement: retries retain the exact unresolved step.
            for (let cleanup = deferredCleanup[0]; cleanup; cleanup = deferredCleanup[0]) {
              await cleanup();
              deferredCleanup.shift();
            }
          },
          (error) => reportCodexBackgroundCleanupFailure(params, error),
        );
        reportCodexBackgroundCleanupFailure(
          params,
          new Error("Native goal shutdown is uncertain; exact-client cleanup custody retained"),
        );
      }
    }
  }
}
