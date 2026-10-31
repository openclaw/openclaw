import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const SUBAGENT_SESSION_RUN_TTL_MS = 5 * 60_000;
export const SUBAGENT_KEEP_RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const SUBAGENT_ARCHIVE_BATCH_ROWS = 128;
export const SUBAGENT_ARCHIVE_BATCH_BYTES = 1024 * 1024;

export function isSubagentKeepRunArchiveDue(entry: SubagentRunRecord, now: number): boolean {
  return (
    entry.cleanup === "keep" &&
    entry.spawnMode !== "session" &&
    !entry.archiveAtMs &&
    !needsSubagentActivation(entry) &&
    entry.execution.endedAt !== undefined &&
    now - entry.execution.endedAt > SUBAGENT_KEEP_RUN_RETENTION_MS &&
    entry.delivery?.status !== "pending" &&
    entry.delivery?.status !== "in_progress" &&
    entry.delivery?.status !== "suspended"
  );
}

export function needsSubagentActivation(entry: SubagentRunRecord): boolean {
  return (
    entry.execution.status !== "terminal" ||
    entry.cleanupCompletedAt === undefined ||
    Boolean(
      // Collectors retain their spawning turn for cancellation, without owing a requester wake.
      (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) ||
      entry.requesterSettleWake ||
      entry.pauseReason ||
      entry.killIntent ||
      entry.killReconciliation ||
      entry.collectorLaunchCleanupPending,
    )
  );
}

export function subagentSweepAt(entry: SubagentRunRecord): number {
  if (
    needsSubagentActivation(entry) ||
    entry.delivery?.status === "pending" ||
    entry.delivery?.status === "in_progress" ||
    entry.delivery?.status === "suspended"
  ) {
    // Unfinished rows may still own live completion or resource cleanup.
    return 0;
  }
  if (entry.archiveAtMs) {
    return entry.archiveAtMs;
  }
  return entry.cleanup === "keep" && entry.spawnMode !== "session"
    ? (entry.execution.endedAt ?? Infinity) + SUBAGENT_KEEP_RUN_RETENTION_MS + 1
    : (entry.cleanupCompletedAt ?? Infinity) + SUBAGENT_SESSION_RUN_TTL_MS + 1;
}

/** Only registry publication changes membership; time promotes retained cleanup candidates. */
export class SubagentRunWorkIndex {
  readonly activationRuns = new Map<string, SubagentRunRecord>();
  private readonly sweepRuns = new Map<string, SubagentRunRecord>();
  private readonly deadlines = new Map<string, { at: number; entry: SubagentRunRecord }>();
  private nextSweepAt = Infinity;

  set(runId: string, entry: SubagentRunRecord): void {
    if (needsSubagentActivation(entry)) {
      this.activationRuns.set(runId, entry);
    } else {
      this.activationRuns.delete(runId);
    }
    this.deadlines.delete(runId);
    const at = subagentSweepAt(entry);
    if (at === 0) {
      this.sweepRuns.set(runId, entry);
    } else {
      this.sweepRuns.delete(runId);
      if (at < Infinity) {
        this.deadlines.set(runId, { at, entry });
        this.nextSweepAt = Math.min(this.nextSweepAt, at);
      }
    }
  }

  delete(runId: string): void {
    this.activationRuns.delete(runId);
    this.sweepRuns.delete(runId);
    this.deadlines.delete(runId);
  }

  clear(): void {
    this.activationRuns.clear();
    this.sweepRuns.clear();
    this.deadlines.clear();
    this.nextSweepAt = Infinity;
  }

  sweepCandidates(now: number): Iterable<SubagentRunRecord> {
    if (this.nextSweepAt <= now) {
      this.nextSweepAt = Infinity;
      for (const [runId, { at, entry }] of this.deadlines) {
        if (at <= now) {
          this.deadlines.delete(runId);
          this.sweepRuns.set(runId, entry);
        } else {
          this.nextSweepAt = Math.min(this.nextSweepAt, at);
        }
      }
    }
    return this.sweepRuns.values();
  }
}
