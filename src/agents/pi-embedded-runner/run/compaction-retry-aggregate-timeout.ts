/**
 * Maximum number of times the timeout window can be extended while compaction
 * reports itself as still in-flight.  Without a cap, a stuck
 * `isCompactionStillInFlight` signal would extend the wait indefinitely,
 * leaving the session in a zombie state.
 *
 * Each extension adds `aggregateTimeoutMs` to the total wait, so the absolute
 * upper bound is `(MAX_EXTENSIONS + 1) * aggregateTimeoutMs`.
 *
 * See: https://github.com/openclaw/openclaw/issues/48518
 */
const MAX_COMPACTION_INFLIGHT_EXTENSIONS = 3;

/**
 * Wait for compaction retry completion with an aggregate timeout to avoid
 * holding a session lane indefinitely when retry resolution is lost.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
  isCompactionStillInFlight?: () => boolean;
}): Promise<{ timedOut: boolean }> {
  const timeoutMsRaw = params.aggregateTimeoutMs;
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1, Math.floor(timeoutMsRaw)) : 1;

  let timedOut = false;
  let inflightExtensions = 0;
  const waitPromise = params.waitForCompactionRetry().then(() => "done" as const);

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

      if (result === "done") {
        break;
      }

      // Keep extending the timeout window while compaction is actively running,
      // but only up to MAX_COMPACTION_INFLIGHT_EXTENSIONS times to prevent
      // indefinite zombie state when isCompactionStillInFlight is stuck.
      if (
        params.isCompactionStillInFlight?.() &&
        inflightExtensions < MAX_COMPACTION_INFLIGHT_EXTENSIONS
      ) {
        inflightExtensions++;
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
