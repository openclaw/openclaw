import { setTimeout as delay } from "node:timers/promises";

export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: {
    abortSignal?: AbortSignal;
    onError?: (err: unknown) => void;
    onReconnect?: (delayMs: number) => void;
    reconnectAfterClose?: boolean;
  } = {},
): Promise<void> {
  let retryDelay = 2000;
  while (!opts.abortSignal?.aborted) {
    let failed = false;
    try {
      await connectFn();
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        return;
      }
      failed = true;
      opts.onError?.(err);
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    if (!failed) {
      retryDelay = 2000;
    }
    const spread = retryDelay * 0.2;
    const delayMs = Math.round(retryDelay - spread + Math.random() * spread * 2);
    if (!failed && opts.reconnectAfterClose === false) {
      return;
    }
    opts.onReconnect?.(delayMs);
    try {
      await delay(delayMs, undefined, { signal: opts.abortSignal });
    } catch (delayError) {
      if (!opts.abortSignal?.aborted) {
        throw delayError;
      }
    }
    if (failed) {
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  }
}
