import { apiThrottler } from "./bot.runtime.js";

type ApiThrottlerTransformer = ReturnType<typeof apiThrottler>;

const throttlerByToken = new Map<string, ApiThrottlerTransformer>();

/**
 * Returns the shared apiThrottler transformer for a given bot token, creating
 * it on first call. Reusing the transformer across all Bot instances for the
 * same token ensures the underlying Bottleneck instances (global 30 req/sec,
 * group 20 msg/min, out 1/sec) are shared between the polling bot and CLI
 * delivery paths, which both count against the same per-token Telegram quota.
 */
export function getOrCreateAccountThrottler(token: string): ApiThrottlerTransformer {
  let throttler = throttlerByToken.get(token);
  if (!throttler) {
    throttler = apiThrottler();
    throttlerByToken.set(token, throttler);
  }
  return throttler;
}

export function clearAccountThrottlersForTest(): void {
  throttlerByToken.clear();
}
