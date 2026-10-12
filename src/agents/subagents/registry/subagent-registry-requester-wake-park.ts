import {
  readRequesterSettleOwnerChangedMessage,
  REQUESTER_SETTLE_OWNER_CHANGED_MESSAGE,
} from "../completion/subagent-completion-mutation.kernel.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-log.js";
import { REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS } from "./subagent-registry-requester-wake-commit.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Only the owner-changed rejection counts: it is a pure function of persisted rows, so
// repeating the same plan is unlikely to recover on its own. Storage and transport failures
// never count; they keep today's retry cadence until the store recovers (#154252).
//
// Budget: the commit retry backoff is 30s doubling to a 120s cap (deferWakeCommit in
// subagent-registry-requester-wake-commit.ts), so the waits after rejections 1..4 are
// 30s, 60s, 120s and 120s. The fifth rejection, which parks the episode, lands 330s (5.5
// minutes) after the first; the controller-level test "spends the documented 330s between the
// first and fifth rejection" in subagent-registry.requester-wake-park.test.ts measures that
// lower bound with the real controller timer. It is the backoff alone: a sweeper resume (60s
// interval, subagent-registry-sweeper.ts) is not part of the measurement.
//
// The signature includes the first failing runId on purpose: a different failing member is a
// different obstacle, so a flapping cohort resets the count and is never parked for its churn
// alone. The counters live on the in-memory retry episode, so a Gateway restart starts a new
// episode: a row that still cannot settle spends five fresh attempts per boot and is then
// parked again. No schema change is needed for that.
//
// Parking drops the episode's cadence to a slow probe; it closes nothing. Nothing in the row
// changes: the wake stays retained, the captured result stays on the row, and no event reaches
// the requester. #154129 removed its own five-failure cutoff because count-based abandonment
// can discard a captured result, and repeated rejection does not prove the wake can never
// settle. A later heal of the divergence, a build that fixes the cause (#163195), or a restart
// still settles it automatically.
const REQUESTER_SETTLE_WAKE_PARK_AFTER_FAILURES = 5;

function resetOwnerChangedCount(episode: PendingRequesterSettleWakeCommit): void {
  episode.ownerChangedSignature = undefined;
  episode.ownerChangedFailures = 0;
  episode.parked = false;
}

/**
 * Settle a non-delivered wake, parking the retry episode once the same owner-changed
 * rejection has repeated across consecutive attempts. Every failure is rethrown so the
 * ordinary retain-and-defer path runs; parking only changes how far ahead it defers. Any
 * other failure, a yield cohort member, or a different signature resets the count and
 * un-parks the episode.
 */
export async function settleOrParkRequesterWake(
  context: SubagentLifecycleWakeContext,
  episode: PendingRequesterSettleWakeCommit,
  members: readonly SubagentRunRecord[],
  settle: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await settle();
  } catch (error) {
    const signature = readRequesterSettleOwnerChangedMessage(error);
    // A paused yield cohort still owns unfinished requester work; it is never parked.
    if (!signature || members.some((member) => member.pauseReason === "sessions_yield")) {
      resetOwnerChangedCount(episode);
      throw error;
    }
    if (episode.ownerChangedSignature !== signature) {
      resetOwnerChangedCount(episode);
    }
    const failures = (episode.ownerChangedFailures ?? 0) + 1;
    episode.ownerChangedSignature = signature;
    episode.ownerChangedFailures = failures;
    if (failures >= REQUESTER_SETTLE_WAKE_PARK_AFTER_FAILURES && !episode.parked) {
      episode.parked = true;
      context.options.warn("requester settle wake parked", {
        rejection: REQUESTER_SETTLE_OWNER_CHANGED_MESSAGE,
        failures,
        probeIntervalMs: REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS,
        runIds: members.map((member) => maskLifecycleIdentifier(member.runId, "run")),
      });
    }
    throw error;
  }
}
