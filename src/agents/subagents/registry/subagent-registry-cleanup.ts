import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isClaimedByLiveRequesterTurn } from "./subagent-requester-turn-liveness.js";

/** Delivery admission renews its window per generation; without one it expires from completion. */
export function resolveAnnounceDeliveryDeadline(entry: SubagentRunRecord, now: number): number {
  const delivery = entry.delivery;
  const deadline =
    delivery?.deadlineAt ??
    (delivery?.windowStartedAt ?? entry.execution.endedAt ?? now) +
      ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
  // A live requester owns its wait; only an orphan spends the delivery deadline.
  return now >= deadline &&
    isClaimedByLiveRequesterTurn(entry, delivery?.requesterDelivery?.blockingRunId ?? "")
    ? now + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS
    : deadline;
}
