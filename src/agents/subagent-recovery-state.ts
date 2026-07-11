/**
 * Subagent orphan recovery gate.
 *
 * Bounds automatic recovery attempts and tombstones repeatedly wedged session entries.
 * Includes a cumulative cross-boot ceiling (#95750) so slow reboot loops cannot keep
 * re-accepting orphan resume forever. Main-session restart recovery keeps its own fuse;
 * this is the canonical subagent surface.
 */
import type { SessionEntry } from "../config/sessions.js";

/** Rapid-burst ceiling inside the rewedge window (same-boot stop-the-bleed). */
const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
/**
 * Cumulative accepted automatic orphan-recovery resumes allowed for the same entry
 * across boots before permanent tombstone. Mirrors main-session restart-recovery
 * MAX_RECOVERY_RETRIES semantics (resume while attempts == MAX still allowed; block when
 * attempts > MAX). See #95750 review P1b.
 */
export const SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS = 3;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 60_000;

/** Decision returned before attempting automatic subagent orphan recovery. */
export type SubagentRecoveryGate =
  | {
      allowed: true;
      nextAttempt: number;
    }
  | {
      allowed: false;
      reason: string;
      shouldMarkWedged: boolean;
    };

function normalizeAutomaticAttempts(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Attempts outside the rewedge window stop counting toward the *rapid* burst budget,
// but cumulative automaticAttempts still gate across reboots.
function isRecentRecoveryAttempt(entry: SessionEntry, now: number): boolean {
  const lastAttemptAt = entry.subagentRecovery?.lastAttemptAt;
  return (
    typeof lastAttemptAt === "number" &&
    Number.isFinite(lastAttemptAt) &&
    now - lastAttemptAt <= SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS
  );
}

/** Returns true when recovery has been tombstoned for a session entry. */
export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const recovery = (entry as SessionEntry).subagentRecovery;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

/** Formats the operator-facing reason for a wedged recovery entry. */
export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

function buildCumulativeBudgetReason(previousAttempts: number): string {
  return (
    `subagent orphan recovery blocked after ${previousAttempts} accepted resume attempts ` +
    `across boots (budget ${SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS}); ` +
    `run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`
  );
}

/** Checks whether automatic orphan recovery may run for this session entry. */
export function evaluateSubagentRecoveryGate(
  entry: SessionEntry,
  now: number,
): SubagentRecoveryGate {
  if (isSubagentRecoveryWedgedEntry(entry)) {
    return {
      allowed: false,
      reason: formatSubagentRecoveryWedgedReason(entry),
      shouldMarkWedged: false,
    };
  }

  const cumulativeAttempts = normalizeAutomaticAttempts(entry.subagentRecovery?.automaticAttempts);
  // Cross-boot ceiling: cumulative accepted resumes persist past the rewedge window.
  // Strict greater-than so attempts === MAX still offered one final resume (same
  // boundary as main-session restartRecoveryAttempts). See #95750.
  if (cumulativeAttempts > SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS) {
    return {
      allowed: false,
      reason: buildCumulativeBudgetReason(cumulativeAttempts),
      shouldMarkWedged: true,
    };
  }

  const previousAttempts = isRecentRecoveryAttempt(entry, now) ? cumulativeAttempts : 0;
  if (previousAttempts >= SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      allowed: false,
      reason:
        `subagent orphan recovery blocked after ${previousAttempts} rapid accepted resume attempts; ` +
        `run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`,
      shouldMarkWedged: true,
    };
  }

  return {
    allowed: true,
    // Always advance the durable counter from the true cumulative total, not a
    // window-reset 0, so the cross-boot budget survives slow reboot loops.
    nextAttempt: cumulativeAttempts + 1,
  };
}

/** Records one accepted automatic orphan-recovery attempt. */
export function markSubagentRecoveryAttempt(params: {
  entry: SessionEntry;
  now: number;
  runId: string;
  attempt: number;
}): void {
  const prior = normalizeAutomaticAttempts(params.entry.subagentRecovery?.automaticAttempts);
  // Monotonic advance: never shrink cumulative budget on re-mark/stale snapshot.
  const nextAttempts = Math.max(prior, Math.max(1, params.attempt));
  // Avoid double-charge when a concurrent writer already advanced to nextAttempts
  // for the same conceptual resume (prior === requested attempt already applied).
  params.entry.subagentRecovery = {
    ...params.entry.subagentRecovery,
    automaticAttempts: nextAttempts,
    lastAttemptAt: params.now,
    lastRunId: params.runId,
  };
}

/** Tombstones automatic recovery until maintenance or doctor clears the state. */
export function markSubagentRecoveryWedged(params: {
  entry: SessionEntry;
  now: number;
  runId?: string;
  reason: string;
}): void {
  params.entry.abortedLastRun = false;
  const prior = normalizeAutomaticAttempts(params.entry.subagentRecovery?.automaticAttempts);
  params.entry.subagentRecovery = {
    ...params.entry.subagentRecovery,
    // Keep the higher of prior cumulative count vs rapid-burst floor so doctor
    // still sees that recovery was exhausted; never shrink over-budget counts.
    automaticAttempts: Math.max(prior, SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS),
    lastAttemptAt: params.entry.subagentRecovery?.lastAttemptAt ?? params.now,
    ...(params.runId ? { lastRunId: params.runId } : {}),
    wedgedAt: params.now,
    wedgedReason: params.reason,
  };
  params.entry.updatedAt = params.now;
}

/** Clears stale abort state when a wedged entry should no longer look runnable. */
export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
