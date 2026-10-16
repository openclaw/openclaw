import { setTimeout as delay } from "node:timers/promises";

type RunWithReconnectOpts = {
  abortSignal?: AbortSignal;
  onError?: (err: unknown) => void;
  onReconnect?: (delayMs: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  reconnectAfterClose?: boolean;
};

export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: RunWithReconnectOpts = {},
): Promise<void> {
  const { initialDelayMs = 2000, maxDelayMs = 60_000 } = opts;
  const jitterRatio = Math.max(0, opts.jitterRatio ?? 0);
  const random = opts.random ?? Math.random;
  let retryDelay = initialDelayMs;
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
      retryDelay = initialDelayMs;
    }
    const delayMs = withJitter(retryDelay, jitterRatio, random);
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
      retryDelay = Math.min(retryDelay * 2, maxDelayMs);
    }
  }
}

function withJitter(baseMs: number, jitterRatio: number, random: () => number): number {
  if (jitterRatio <= 0) {
    return baseMs;
  }
  const normalized = Math.max(0, Math.min(1, random()));
  const spread = baseMs * jitterRatio;
  return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}
