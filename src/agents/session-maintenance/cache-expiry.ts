import type { PromptCacheExpiryEstimate } from "../embedded-agent-runner/prompt-cache-expiry.js";

/** Scheduling consumes qualified estimates, including explicitly labeled idle heuristics. */
export function planCacheExpiryCompaction(estimate: PromptCacheExpiryEstimate, now = Date.now()) {
  // Even an opted-in caller must not spend compaction work on five-minute or shorter caches.
  if (estimate.windowMs <= 300_000) {
    return undefined;
  }
  const expiresAt = estimate.observedAt + estimate.windowMs;
  if (expiresAt <= now) {
    return undefined;
  }
  // Every eligible window leaves the same five-minute lead for checkpointing.
  const notBefore = Math.max(now, expiresAt - 300_000);
  return { notBefore, expiresAt };
}
