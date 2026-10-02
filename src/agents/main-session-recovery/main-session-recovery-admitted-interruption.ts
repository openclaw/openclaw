import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-types.js";

export function interruptAdmittedMainSessionRecovery(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "mark_admitted_recovery_interrupted" }>,
): MainSessionRecoveryTransitionResult {
  const state = entry.mainRestartRecovery;
  if (entry.sessionId !== command.sessionId) {
    return { kind: "rejected", reason: "session_replaced" };
  }
  if (
    !state ||
    state.cycleId !== command.cycleId ||
    state.chargedAttempts !== command.attempt ||
    state.reservation ||
    state.foregroundClaims ||
    !entry.restartRecoveryRuns?.some(
      (run) =>
        run.runId === command.runId && run.lifecycleGeneration === command.lifecycleGeneration,
    )
  ) {
    return { kind: "rejected", reason: "stale_reservation" };
  }
  if (entry.lifecycleRunId !== command.runId) {
    // A committed restoration may lose its response. Only that exact pending
    // attempt is repeatable; retained run fences do not authorize newer work.
    return entry.status === "running" &&
      entry.abortedLastRun === true &&
      entry.lifecycleRunId === undefined &&
      entry.restartRecoveryDeliveryRunId === undefined
      ? { kind: "no_change" }
      : { kind: "rejected", reason: "stale_reservation" };
  }
  entry.status = "running";
  entry.lifecycleRunId = undefined;
  entry.lastRunId = undefined;
  entry.abortedLastRun = true;
  entry.startedAt = undefined;
  entry.endedAt = undefined;
  entry.runtimeMs = undefined;
  if (entry.restartRecoveryDeliveryRunId === command.runId) {
    // Rotate the failed RPC id on retry so dedupe cannot replay its terminal failure.
    entry.restartRecoveryDeliveryRunId = undefined;
  }
  entry.updatedAt = command.now;
  return { kind: "applied" };
}
