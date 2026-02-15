/**
 * Helpers for waiting on compaction retries without blocking a session lane indefinitely.
 */

export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
}): Promise<{ timedOut: boolean }> {
  const timeoutMsRaw = params.aggregateTimeoutMs;
  const timeoutMs = Math.max(1, Math.floor(timeoutMsRaw));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const result = await params.abortable(
      Promise.race([
        params.waitForCompactionRetry().then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]),
    );

    if (result === "timeout") {
      timedOut = true;
      params.onTimeout?.();
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  return { timedOut };
}
