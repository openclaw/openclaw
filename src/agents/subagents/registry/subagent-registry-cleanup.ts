import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const shouldSuspendPendingFinalDelivery = (entry: SubagentRunRecord) =>
  entry.expectsCompletionMessage === true &&
  entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE &&
  entry.execution.outcome?.status === "ok";

type DeferredCleanupDecision =
  | {
      kind: "defer-descendants";
      delayMs: number;
    }
  | {
      kind: "give-up";
      reason: "expiry" | "permanent_failure";
      retryCount?: number;
    }
  | {
      kind: "retry";
      retryCount: number;
      resumeDelayMs?: number;
    };

/** Required-delivery retries renew their window; optional delivery expires from completion. */
export function resolveAnnounceDeliveryDeadline(
  entry: SubagentRunRecord,
  now: number,
  expiryMs: number,
): number {
  const delivery = entry.expectsCompletionMessage === true ? entry.delivery : undefined;
  return (
    delivery?.deadlineAt ?? (delivery?.windowStartedAt ?? entry.execution.endedAt ?? now) + expiryMs
  );
}

export function resolveDeferredCleanupDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  activeDescendantRuns: number;
  announceExpiryMs: number;
  announceCompletionHardExpiryMs: number;
  deferDescendantDelayMs: number;
  resolveAnnounceRetryDelayMs: (retryCount: number) => number;
}): DeferredCleanupDecision {
  const isCompletionMessageFlow = params.entry.expectsCompletionMessage === true;
  const expiryMs = isCompletionMessageFlow
    ? params.announceCompletionHardExpiryMs
    : params.announceExpiryMs;
  const expiryExceeded =
    params.now >= resolveAnnounceDeliveryDeadline(params.entry, params.now, expiryMs);
  if (isCompletionMessageFlow && params.activeDescendantRuns > 0) {
    if (expiryExceeded) {
      return { kind: "give-up", reason: "expiry" };
    }
    return { kind: "defer-descendants", delayMs: params.deferDescendantDelayMs };
  }

  const retryCount = (params.entry.delivery?.attemptCount ?? 0) + 1;
  if (params.entry.delivery?.disposition === "permanent_failure" || expiryExceeded) {
    return {
      kind: "give-up",
      reason:
        params.entry.delivery?.disposition === "permanent_failure" ? "permanent_failure" : "expiry",
      retryCount,
    };
  }

  const persistedNextAttemptAt = params.entry.delivery?.nextAttemptAt;
  const nextAttemptAt =
    typeof persistedNextAttemptAt === "number" && persistedNextAttemptAt > params.now
      ? persistedNextAttemptAt
      : params.now + params.resolveAnnounceRetryDelayMs(retryCount);

  return {
    kind: "retry",
    retryCount,
    resumeDelayMs: nextAttemptAt - params.now,
  };
}
