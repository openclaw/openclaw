import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/**
 * Waits for compaction retry completion without holding a session lane
 * indefinitely. The aggregate timeout becomes terminal only after compaction is
 * no longer reported in flight, which lets legitimate long compactions finish
 * while still bounding idle waits.
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
        // Each loop schedules a fresh bounded timer so enormous configured
        // budgets stay clamped by resolveTimerTimeoutMs on every wait window.
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
