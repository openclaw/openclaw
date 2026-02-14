/**
 * Reconnection loop with exponential backoff.
 *
 * Calls `connectFn` in a while loop. On normal resolve (connection closed),
 * the backoff resets. On thrown error (connection failed), the current delay is
 * used, then doubled for the next retry.
 * The loop exits when `abortSignal` fires.
 */
export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: {
    abortSignal?: AbortSignal;
    onError?: (err: unknown) => void;
    onReconnect?: (delayMs: number) => void;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<void> {
  const { initialDelayMs = 2000, maxDelayMs = 60_000 } = opts;
  let retryDelay = initialDelayMs;

  while (!opts.abortSignal?.aborted) {
    let shouldIncreaseDelay = false;
    try {
      await connectFn();
      retryDelay = initialDelayMs;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        return;
      }
      opts.onError?.(err);
      shouldIncreaseDelay = true;
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    opts.onReconnect?.(retryDelay);
    await sleepAbortable(retryDelay, opts.abortSignal);
    if (shouldIncreaseDelay) {
      retryDelay = Math.min(retryDelay * 2, maxDelayMs);
    }
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
