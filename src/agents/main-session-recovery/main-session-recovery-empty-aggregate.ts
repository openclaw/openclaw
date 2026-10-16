import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";

export function isMainRestartRecoveryAggregateEmptyAndUnowned(entry: SessionEntry): boolean {
  const state = entry.mainRestartRecovery;
  return (
    entry.abortedLastRun !== true &&
    state !== undefined &&
    state.chargedAttempts === 0 &&
    state.startedAttempt === undefined &&
    state.executionIdentity === undefined &&
    state.reservation === undefined &&
    state.foregroundClaims === undefined &&
    state.tombstone === undefined &&
    entry.restartRecoveryRuns === undefined &&
    entry.restartRecoveryDeliveryRunId === undefined &&
    entry.pendingFinalDelivery === undefined
  );
}
