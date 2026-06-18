/**
 * Caps compaction retry waits against the aggregate run timeout.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/**
 * Lower bound on the aggregate retry-wait budget. Preserves the historical
 * 60s floor so installs that have not raised `agents.defaults.compaction
 * .timeoutSeconds` keep the same behavior they had before this helper existed.
 */
export const COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS = 60_000;

/**
 * Slack added on top of the inner compaction model-call safety timeout so the
 * outer aggregate wait never trips before the inner timeout has had a chance
 * to fire and surface a real error. Without this margin, a compaction call
 * that just barely fits inside `compaction.timeoutSeconds` could still race
 * the aggregate wait and have its result silently discarded — see #94391.
 */
export const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Derive the outer aggregate-wait budget from the inner compaction model-call
 * timeout.
 *
 * The inner safety timeout (`agents.defaults.compaction.timeoutSeconds`,
 * default 180s) bounds how long a single compaction model call may run. The
 * outer aggregate wait must always be at least that large plus a small
 * margin, otherwise the outer wait abandons valid compaction results that
 * the provider already returned (and which the caller has already paid for).
 *
 * Operators who raise `compaction.timeoutSeconds` automatically pick up a
 * matching aggregate-wait budget; installs without that override fall back
 * to the historical 60s floor.
 */
export function resolveCompactionRetryAggregateTimeoutMs(compactionTimeoutMs?: number): number {
  if (
    typeof compactionTimeoutMs !== "number" ||
    !Number.isFinite(compactionTimeoutMs) ||
    compactionTimeoutMs <= 0
  ) {
    return COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS;
  }
  return Math.max(
    COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    compactionTimeoutMs + COMPACTION_RETRY_AGGREGATE_TIMEOUT_MARGIN_MS,
  );
}

/**
 * Waits for compaction retry completion with an aggregate timeout so a lost
 * retry resolution cannot hold the session lane indefinitely.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
  isCompactionStillInFlight?: () => boolean;
}): Promise<{ timedOut: boolean }> {
  const timeoutMs = resolveTimerTimeoutMs(params.aggregateTimeoutMs, 1);

  let timedOut = false;
  // Reflect the retry promise so late rejections after a timeout stay handled
  // without masking failures that settle before the timeout path wins.
  const waitPromise = params.waitForCompactionRetry().then(
    () => ({ kind: "done" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await params.abortable(
        Promise.race([
          waitPromise,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]),
      );

      if (result !== "timeout") {
        if (result.kind === "done") {
          break;
        }
        throw result.error;
      }

      // Keep extending the timeout window while compaction is actively running.
      // We only trigger the fallback timeout once compaction appears idle.
      if (params.isCompactionStillInFlight?.()) {
        continue;
      }

      timedOut = true;
      params.onTimeout?.();
      break;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return { timedOut };
}
