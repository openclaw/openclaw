import type { PromptCacheExpiryEstimate } from "../embedded-agent-runner/prompt-cache-expiry.js";

/** Scheduling consumes recorded transport facts without loading provider runtimes. */
export function planCacheExpiryCompaction(estimate: PromptCacheExpiryEstimate, now = Date.now()) {
  const expiresAt = estimate.observedAt + estimate.windowMs;
  if (expiresAt <= now) {
    return undefined;
  }
  // Leave a bounded lead for checkpointing, derived from this route's actual window.
  const notBefore = Math.max(now, expiresAt - Math.min(60_000, estimate.windowMs / 10));
  return { notBefore, expiresAt };
}
