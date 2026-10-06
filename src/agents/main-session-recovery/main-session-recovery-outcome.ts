import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
} from "../../config/sessions/restart-recovery-state.js";
import { isTerminalSessionStatus } from "../../config/sessions/types.js";

/** A terminal outcome plus a bare runtime fence cannot establish unfinished work. */
export function hasUnownedTerminalMainSessionRecoveryFence(entry: SessionEntry): boolean {
  return (
    isTerminalSessionStatus(entry.status) &&
    entry.status !== "interrupted" &&
    !entry.mainRestartRecovery &&
    !entry.lifecycleRunId &&
    !entry.activeWriterRunId &&
    !entry.restartRecoveryDeliveryRunId &&
    !entry.restartRecoveryHarnessCompletion &&
    !entry.pendingFinalDelivery &&
    entry.restartRecoveryRuns?.some((run) => !hasRestartRecoveryTerminalRun(entry, run.runId)) ===
      true
  );
}

/** A later foreground outcome cannot settle a different run's recovery fence. */
export function hasCompletedMainSessionRecoveryOutcome(entry: SessionEntry): boolean {
  return (
    isTerminalSessionStatus(entry.status) &&
    entry.status !== "interrupted" &&
    !isRetryableUnadoptedChatClaim(entry) &&
    !entry.pendingFinalDelivery &&
    (entry.restartRecoveryRuns ?? []).every((run) =>
      hasRestartRecoveryTerminalRun(entry, run.runId),
    )
  );
}

// Retire only proven terminal fences without remaining execution or delivery
// custody; treating unfinished fences as residue loses crash recovery (#118873).
export function isMainRestartRecoveryTerminalOnly(entry: SessionEntry): boolean {
  const state = entry.mainRestartRecovery;
  if (state?.tombstone || state?.reservation || state?.foregroundClaims) {
    return false;
  }
  if (entry.restartRecoveryDeliveryRunId !== undefined || entry.pendingFinalDelivery) {
    return false;
  }
  const runs = entry.restartRecoveryRuns;
  return (
    runs !== undefined &&
    runs.length > 0 &&
    runs.every((run) => hasRestartRecoveryTerminalRun(entry, run.runId))
  );
}
