/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentMaintenanceRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function isCleanupCompleteForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  return typeof entry.cleanupCompletedAt === "number";
}

function isActiveForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  return typeof entry.execution.endedAt !== "number";
}

function isPendingFinalDeliveryForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  return entry.delivery?.status === "pending" || isDeliverySuspended(entry);
}

function isAwaitingCompletionAnnounceForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  return entry.expectsCompletionMessage === true && entry.delivery?.status !== "delivered";
}

function shouldPreserveForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  if (entry.killReconciliation || entry.killIntent) {
    // The killed row is a reconciliation tombstone. Its session owns the
    // provider result until the sweeper accepts completion or finalizes cancellation.
    return true;
  }
  if (isCleanupCompleteForMaintenance(entry)) {
    return false;
  }
  if (isActiveForMaintenance(entry)) {
    return true;
  }
  return (
    isAwaitingCompletionAnnounceForMaintenance(entry) || isPendingFinalDeliveryForMaintenance(entry)
  );
}

/** Lists child session keys protected from session-store maintenance pruning. */
function listSessionMaintenanceProtectedSubagentSessionKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of getSubagentMaintenanceRunsSnapshotForRead(subagentRuns).values()) {
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

registerSessionMaintenancePreserveKeysProvider(listSessionMaintenanceProtectedSubagentSessionKeys);
