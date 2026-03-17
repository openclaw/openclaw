const MAX_DISCORD_TIMEOUT_MS = 2147483647;
const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 12e4;
const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS = 30 * 6e4;
function clampDiscordTimeoutMs(timeoutMs, minimumMs) {
  return Math.max(minimumMs, Math.min(Math.floor(timeoutMs), MAX_DISCORD_TIMEOUT_MS));
}
function normalizeDiscordListenerTimeoutMs(raw) {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) {
    return DISCORD_DEFAULT_LISTENER_TIMEOUT_MS;
  }
  return clampDiscordTimeoutMs(raw, 1e3);
}
function normalizeDiscordInboundWorkerTimeoutMs(raw) {
  if (raw === 0) {
    return void 0;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS;
  }
  return clampDiscordTimeoutMs(raw, 1);
}
function isAbortError(error) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return "name" in error && String(error.name) === "AbortError";
}
function mergeAbortSignals(signals) {
  const activeSignals = signals.filter((signal) => Boolean(signal));
  if (activeSignals.length === 0) {
    return void 0;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const fallbackController = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      fallbackController.abort();
      return fallbackController.signal;
    }
  }
  const abortFallback = () => {
    fallbackController.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abortFallback);
    }
  };
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abortFallback, { once: true });
  }
  return fallbackController.signal;
}
async function runDiscordTaskWithTimeout(params) {
  const timeoutAbortController = params.timeoutMs ? new AbortController() : void 0;
  const mergedAbortSignal = mergeAbortSignals([
    ...params.abortSignals ?? [],
    timeoutAbortController?.signal
  ]);
  let timedOut = false;
  let timeoutHandle = null;
  const runPromise = params.run(mergedAbortSignal).catch((error) => {
    if (!timedOut) {
      throw error;
    }
    if (timeoutAbortController?.signal.aborted && isAbortError(error)) {
      params.onAbortAfterTimeout?.();
      return;
    }
    params.onErrorAfterTimeout?.(error);
  });
  try {
    if (!params.timeoutMs) {
      await runPromise;
      return false;
    }
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      runPromise.then(() => "completed"),
      timeoutPromise
    ]);
    if (result === "timeout") {
      timedOut = true;
      timeoutAbortController?.abort();
      params.onTimeout(params.timeoutMs);
      return true;
    }
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
export {
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  isAbortError,
  mergeAbortSignals,
  normalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs,
  runDiscordTaskWithTimeout
};
