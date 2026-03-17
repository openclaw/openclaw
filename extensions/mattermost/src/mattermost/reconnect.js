async function runWithReconnect(connectFn, opts = {}) {
  const { initialDelayMs = 2e3, maxDelayMs = 6e4 } = opts;
  const jitterRatio = Math.max(0, opts.jitterRatio ?? 0);
  const random = opts.random ?? Math.random;
  let retryDelay = initialDelayMs;
  let attempt = 0;
  while (!opts.abortSignal?.aborted) {
    let shouldIncreaseDelay = false;
    let outcome = "resolved";
    let error;
    try {
      await connectFn();
      retryDelay = initialDelayMs;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        return;
      }
      outcome = "rejected";
      error = err;
      opts.onError?.(err);
      shouldIncreaseDelay = true;
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    const delayMs = withJitter(retryDelay, jitterRatio, random);
    const shouldReconnect = opts.shouldReconnect?.({
      attempt,
      delayMs,
      outcome,
      error
    }) ?? true;
    if (!shouldReconnect) {
      return;
    }
    opts.onReconnect?.(delayMs);
    await sleepAbortable(delayMs, opts.abortSignal);
    if (shouldIncreaseDelay) {
      retryDelay = Math.min(retryDelay * 2, maxDelayMs);
    }
    attempt++;
  }
}
function withJitter(baseMs, jitterRatio, random) {
  if (jitterRatio <= 0) {
    return baseMs;
  }
  const normalized = Math.max(0, Math.min(1, random()));
  const spread = baseMs * jitterRatio;
  return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}
function sleepAbortable(ms, signal) {
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
export {
  runWithReconnect
};
