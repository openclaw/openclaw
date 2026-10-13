import {
  readRequesterSettleOwnerChangedMessage,
  REQUESTER_SETTLE_OWNER_CHANGED_MESSAGE,
} from "../completion/subagent-completion-mutation.kernel.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Only the owner-changed rejection counts: it is a pure function of persisted rows, so
// repeating the same plan is unlikely to recover on its own. Storage and transport failures
// never count; their own sustained-failure warning already covers them (#154252).
//
// Budget: the commit retry backoff is 30s doubling to a 120s cap (deferWakeCommit in
// subagent-registry-requester-wake-commit.ts), so the waits after rejections 1..4 are
// 30s, 60s, 120s and 120s. The fifth rejection, which reports the episode, lands 330s (5.5
// minutes) after the first; the controller-level test "spends the documented 330s between the
// first and fifth rejection" in subagent-registry.requester-wake-owner-changed.test.ts measures
// that lower bound with the real controller timer.
//
// The signature includes the first failing runId on purpose: a different failing member is a
// different obstacle, so a flapping cohort resets the count and is never reported for its churn
// alone. The counters live on the in-memory retry episode, so a Gateway restart starts a new
// episode: a row that still cannot settle is reported once more after five fresh attempts.
//
// Reporting changes nothing else. The retry cadence stays the 120s ceiling that #157871 kept so
// settlement remains prompt once the divergence heals; the wake stays retained, the captured
// result stays on the row, and no event reaches the requester. #154129 removed its own
// five-failure cutoff because count-based abandonment can discard a captured result.
const REQUESTER_SETTLE_WAKE_OWNER_CHANGED_REPORT_AFTER = 5;

function resetOwnerChangedCount(episode: PendingRequesterSettleWakeCommit): void {
  episode.ownerChangedSignature = undefined;
  episode.ownerChangedFailures = 0;
  episode.ownerChangedReported = false;
}

/**
 * Settle a non-delivered wake, reporting the retry episode once the same owner-changed
 * rejection has repeated across consecutive attempts. Every failure is rethrown so the
 * ordinary retain-and-defer path runs at its usual cadence. Any other failure, a yield cohort
 * member, or a different signature resets the count.
 */
export async function settleOrReportRequesterWake(
  context: SubagentLifecycleWakeContext,
  episode: PendingRequesterSettleWakeCommit,
  members: readonly SubagentRunRecord[],
  settle: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await settle();
  } catch (error) {
    const signature = readRequesterSettleOwnerChangedMessage(error);
    // A paused yield cohort still owns unfinished requester work; it is never reported.
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
    if (
      failures >= REQUESTER_SETTLE_WAKE_OWNER_CHANGED_REPORT_AFTER &&
      !episode.ownerChangedReported
    ) {
      episode.ownerChangedReported = true;
      context.options.warn(
        "requester settle wake keeps failing on an owner change; retries continue",
        {
          rejection: REQUESTER_SETTLE_OWNER_CHANGED_MESSAGE,
          failures,
          runIds: members.map((member) => member.runId),
        },
      );
    }
    throw error;
  }
}
