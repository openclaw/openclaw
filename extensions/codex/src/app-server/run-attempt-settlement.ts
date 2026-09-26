import { addAbortListener } from "node:events";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { TURN_FINALIZE_DRAIN_ABORT_GRACE_MS } from "./attempt-timeouts.js";
import { readCodexRetainedBackgroundCommands } from "./native-process-authority.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export async function beginCodexAttemptSettlement(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  activeTurn: CodexAttemptActiveTurn,
) {
  const { state: resourceState } = resources;
  const { connection } = resources.prompt.context.runtime;
  const { params, runAbortController, appServer } = connection;
  const { state, deadlines, settlementExpired } = turnRuntime;
  const { drainNotificationQueue } = notifications;
  const { activeProjector, activeTurnId } = activeTurn;
  const drainGraceElapsed = createDeferred<void>();
  let settlementPhase: "active" | "expired" | "closed" = "active";
  let drainGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const beginDrainGrace = () => {
    if (settlementPhase !== "active" || drainGraceTimer) {
      return;
    }
    drainGraceTimer = setTimeout(() => {
      settlementPhase = "expired";
      drainGraceElapsed.resolve();
    }, TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
    drainGraceTimer.unref?.();
  };
  const abortListener = addAbortListener(runAbortController.signal, () => {
    // Abort may first arrive after native completion. Its authoritative cleanup
    // must finish before projection gets the full five-second drain grace.
    void state.abortCleanup.then(beginDrainGrace, beginDrainGrace);
  });
  const closeProjection = () => {
    state.projectionClosed = true;
    return activeProjector.closeProjection();
  };
  const closeSettlement = () => {
    if (settlementPhase === "closed") {
      return;
    }
    settlementPhase = "closed";
    abortListener[Symbol.dispose]();
    clearTimeout(drainGraceTimer);
    deadlines.dispose();
  };
  if (state.pluginRuntimeRefreshStop) {
    // Snapshot only after native cleanup and projection. Cleanup retains the rejection
    // so a failed handoff still returns its completed effects and preserves its binding.
    await state.pluginRuntimeRefreshStop.catch(() => undefined);
  }
  let readRetainedNativeCommands: (() => ReadonlyMap<string, string>) | undefined;
  const settlement = drainNotificationQueue().then(async () => {
    const commands = activeProjector.getPendingNativeCommands();
    if (commands.size > 0 && !params.oneShotCliRun && !state.pluginRuntimeRefreshStop) {
      try {
        const readCurrent = await readCodexRetainedBackgroundCommands({
          client: resourceState.client,
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          commands,
          authority: resources.nativeProcessAuthority,
          assertCurrent: connection.assertCurrent,
          signal: runAbortController.signal,
          timeoutMs: appServer.requestTimeoutMs,
        });
        readRetainedNativeCommands = () => {
          try {
            return readCurrent();
          } catch {
            // Revoked custody cannot excuse an unfinished command.
            return new Map();
          }
        };
      } catch (error) {
        embeddedAgentLog.debug("could not confirm retained native commands", {
          threadId: resourceState.thread.threadId,
          error: formatErrorMessage(error),
        });
      }
      // Native exit may arrive while the inventory RPC is pending.
      await drainNotificationQueue();
    }
    await closeProjection();
    await activeProjector.settlement.drain();
  });
  const degradedSettlement = settlementExpired.then(() => {
    beginDrainGrace();
  });
  return {
    settlement,
    degradedSettlement,
    drainGraceElapsed,
    closeProjection,
    closeSettlement,
    isActive: () => settlementPhase === "active",
    readRetainedNativeCommands: () => readRetainedNativeCommands?.() ?? new Map<string, string>(),
  };
}
