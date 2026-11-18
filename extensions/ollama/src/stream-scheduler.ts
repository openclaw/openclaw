const COOPERATIVE_YIELD_INTERVAL_MS = 12;
const COOPERATIVE_YIELD_MAX_EVENTS = 64;

export function throwIfOllamaStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }
}

export function createOllamaStreamCooperativeScheduler(signal?: AbortSignal) {
  let lastYieldedAt = Date.now();
  let eventsSinceYield = 0;
  return {
    async afterEvent() {
      throwIfOllamaStreamAborted(signal);
      eventsSinceYield += 1;
      const now = Date.now();
      if (
        eventsSinceYield < COOPERATIVE_YIELD_MAX_EVENTS &&
        now - lastYieldedAt < COOPERATIVE_YIELD_INTERVAL_MS
      ) {
        return;
      }
      eventsSinceYield = 0;
      lastYieldedAt = now;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      throwIfOllamaStreamAborted(signal);
    },
  };
}
