/**
 * Per-pass sweep planning: the order the sweeper visits runs in, and the
 * cleanup identities it freezes before any awaits can let a replacement run
 * take the same slot.
 *
 * Extracted from subagent-registry-sweeper.ts so that file stays under its
 * line cap. Both helpers are pure with respect to the registry map: they read
 * it, they never mutate it.
 */
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import {
  type createSubagentSweepReadScope,
  freezeSessionIdentity,
  type FrozenSessionIdentity,
  isCollectorArchiveReady,
  isSessionCleanupDeferred,
} from "./subagent-registry-sweep-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

type SubagentSweepEntry = [string, SubagentRunRecord];
type SubagentSweepReadScope = ReturnType<typeof createSubagentSweepReadScope>;

/**
 * Visit order for one sweep pass. Requester settle wakes come first, then
 * suspended delivery, interrupted recovery, orphan detection (stale runs
 * first), kill reconciliation, and finally everything else.
 */
export function orderSubagentSweepEntries(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  now: number,
): SubagentSweepEntry[] {
  const phase = ([runId, entry]: SubagentSweepEntry) =>
    entry.requesterSettleWake
      ? 0
      : isSuspendedPendingFinalDelivery(entry)
        ? 1
        : entry.terminalOwner === "interrupted-recovery"
          ? 2
          : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
            ? 3
            : entry.killReconciliation
              ? 4
              : 5;
  return [...runs.entries()].toSorted((left, right) => {
    const phaseDelta = phase(left) - phase(right);
    return (
      phaseDelta ||
      (phase(left) === 3
        ? Number(isStaleUnendedSubagentRun(right[1], now)) -
          Number(isStaleUnendedSubagentRun(left[1], now))
        : 0)
    );
  });
}

/**
 * Completion stays fresh across awaits, but deletion must retain the earlier
 * CAS identity. Bind it to the exact run so replacements wait for another pass.
 */
export async function captureSubagentSweepCleanupIdentities(
  runEntries: readonly SubagentSweepEntry[],
  runs: ReadonlyMap<string, SubagentRunRecord>,
  now: number,
  readScope: SubagentSweepReadScope,
): Promise<Map<object, FrozenSessionIdentity | undefined>> {
  const cleanupIdentities = new Map<object, FrozenSessionIdentity | undefined>();
  for (const [, entry] of runEntries) {
    if (
      typeof entry.execution.endedAt !== "number" ||
      isRestoredQueuedFailureSettlementClaimed(entry) ||
      entry.requesterSettleWake ||
      isSuspendedPendingFinalDelivery(entry) ||
      entry.killIntent ||
      entry.killReconciliation ||
      !(entry.collect && entry.collectorCompletion
        ? entry.collectorLaunchCleanupPending || isCollectorArchiveReady(entry, now)
        : entry.archiveAtMs && entry.archiveAtMs <= now && !isSessionCleanupDeferred(entry))
    ) {
      continue;
    }
    // Suppressed session cleanup still requires the captured member for artifact cleanup.
    if (shouldSuppressSubagentRecoverySessionEffects(entry)) {
      if (runs.get(entry.runId) === entry) {
        cleanupIdentities.set(getSubagentRunRuntimeKey(entry), undefined);
      }
      continue;
    }
    try {
      readScope.assertRunCurrent(entry);
      const identity = await freezeSessionIdentity(entry, () => readScope.assertRunCurrent(entry));
      readScope.assertRunCurrent(entry);
      cleanupIdentities.set(getSubagentRunRuntimeKey(entry), identity);
    } catch (error) {
      if (error !== readScope.retiredRead) {
        throw error;
      }
    }
  }
  return cleanupIdentities;
}
