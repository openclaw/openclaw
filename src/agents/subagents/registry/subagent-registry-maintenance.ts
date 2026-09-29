/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  getSubagentMaintenanceRunsSnapshotForRead,
  prepareSubagentMaintenanceRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function shouldPreserveForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  if (entry.killReconciliation || entry.killIntent) {
    // The killed row is a reconciliation tombstone. Its session owns the
    // provider result until the sweeper accepts completion or finalizes cancellation.
    return true;
  }
  if (typeof entry.cleanupCompletedAt === "number") {
    return false;
  }
  return (
    typeof entry.execution.endedAt !== "number" ||
    (entry.expectsCompletionMessage === true && entry.delivery?.status !== "delivered") ||
    entry.delivery?.status === "pending" ||
    isDeliverySuspended(entry)
  );
}

/** Lists child session keys protected from session-store maintenance pruning. */
function protectedSubagentSessionKeys(runs: Iterable<SubagentRunMaintenanceRecord>): string[] {
  const keys = new Set<string>();
  for (const entry of runs) {
    if (!shouldPreserveForMaintenance(entry)) {
      continue;
    }
    const childSessionKey = entry.childSessionKey.trim();
    if (childSessionKey) {
      keys.add(childSessionKey);
    }
  }
  return [...keys];
}

registerSessionMaintenancePreserveKeysProvider(
  () =>
    protectedSubagentSessionKeys(getSubagentMaintenanceRunsSnapshotForRead(subagentRuns).values()),
  async () => {
    const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(subagentRuns);
    return {
      capture: () => protectedSubagentSessionKeys(prepared.capture().values()),
      dispose: () => prepared.dispose(),
      subagentRunBasis: prepared.basis,
    };
  },
);
