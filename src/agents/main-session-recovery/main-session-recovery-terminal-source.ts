import { isCapturedMainRestartTurnCurrent } from "../../config/sessions/main-session-recovery.types.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";

/** A terminal delivery source cannot claim a different, still-current accepted input. */
export function retireTerminalMainSessionRecoverySource(
  entry: InternalSessionEntry,
  sessionKey: string,
): void {
  const terminalSource = entry.restartRecoveryDeliverySourceRunId;
  const retained = entry.mainRestartRecovery;
  const intent = retained?.turnIntent;
  if (
    terminalSource &&
    hasRestartRecoveryTerminalRun(entry, terminalSource) &&
    intent &&
    intent.runId !== terminalSource &&
    intent.sessionKey === sessionKey &&
    isCapturedMainRestartTurnCurrent(entry) &&
    (entry.restartRecoveryRuns ?? []).every(
      (run) => run.runId === intent.runId && run.lifecycleGeneration === intent.lifecycleGeneration,
    ) &&
    !entry.activeWriterRunId &&
    !entry.lifecycleRunId &&
    !entry.restartRecoveryDeliveryRunId &&
    !entry.pendingFinalDelivery &&
    !retained.reservation &&
    !retained.foregroundClaims &&
    !retained.pause &&
    !retained.acknowledgedPause &&
    !retained.tombstone &&
    !retained.capacityWait &&
    !retained.queuedInputId &&
    !entry.restartRecoveryGoal &&
    !retained.goalIntent
  ) {
    // Orphan capture can restore the accepted turn fence. It owns that intent,
    // not the old terminal delivery source; retain the fence and effect hints.
    entry.restartRecoveryDeliverySourceRunId = undefined;
  }
}
