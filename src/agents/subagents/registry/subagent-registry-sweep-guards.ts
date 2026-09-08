import { hasLiveOrRecentlyDispatchedContinuationWork } from "../../../auto-reply/continuation/work-store.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Admission pressure for recoverable completion deliveries; rows are never pruned for capacity. */
export function getSubagentDeliveryBacklogPressure(): {
  suspended: number;
  blocked: boolean;
} {
  let suspended = 0;
  for (const entry of subagentRuns.values()) {
    if (isDeliverySuspended(entry)) {
      suspended += 1;
    }
  }
  return { suspended, blocked: suspended >= SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP };
}

export function hasContinuationWorkForSweepEntry(entry: SubagentRunRecord): boolean {
  if (hasLiveOrRecentlyDispatchedContinuationWork(entry.childSessionKey)) {
    return true;
  }
  if (!entry.collect || !entry.groupId) {
    return false;
  }
  return [...subagentRuns.values()].some(
    (candidate) =>
      candidate.collect === true &&
      candidate.groupId === entry.groupId &&
      candidate.swarmRequesterSessionKey === entry.swarmRequesterSessionKey &&
      hasLiveOrRecentlyDispatchedContinuationWork(candidate.childSessionKey),
  );
}
