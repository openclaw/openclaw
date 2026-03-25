/**
 * LLM Rate Limit Wrapper — Circuit Breaker
 *
 * Simple cooldown-based circuit breaker. When a provider returns a rate limit
 * error (429), we record a cooldown timestamp. Subsequent requests to that
 * provider are rejected immediately (no API call, no token waste) until the
 * cooldown expires. The existing failover system handles switching providers.
 *
 * No retry loops. No token estimation. No pre-emptive blocking.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamFn = (...args: any[]) => any;

/** Per-provider cooldown timestamps (epoch ms when provider becomes available). */
const providerCooldowns = new Map<string, number>();

/** Default cooldown when we can't parse a Retry-After value. */
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Check if a provider is currently cooling down.
 * Returns remaining cooldown ms, or 0 if available.
 */
export function getProviderCooldownMs(provider: string): number {
  const until = providerCooldowns.get(provider);
  if (!until) {
    return 0;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    providerCooldowns.delete(provider);
    return 0;
  }
  return remaining;
}

/**
 * Mark a provider as cooling down after a rate limit error.
 */
export function setProviderCooldown(provider: string, cooldownMs: number): void {
  providerCooldowns.set(provider, Date.now() + cooldownMs);
}

/**
 * Clear cooldown for a provider (e.g. on successful request).
 */
export function clearProviderCooldown(provider: string): void {
  providerCooldowns.delete(provider);
}

/**
 * Extract cooldown duration from an error message.
 * Looks for patterns like "Retry after 30s" or "retry_after: 60".
 */
function parseCooldownFromError(errMsg: string): number {
  const match = errMsg.match(/retry[_ ]?after[:\s]*(\d+)/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (seconds > 0 && seconds < 600) {
      return seconds * 1000;
    }
  }
  return DEFAULT_COOLDOWN_MS;
}

function isRateLimitError(errMsg: string): boolean {
  return /rate[_ ]?limit|too many requests|\b429\b|quota|resource[_ ]?exhausted/i.test(errMsg);
}

type RateLimitWrapperOptions = {
  provider: string;
  onRateLimited?: (waitMs: number, reason: string) => void;
  onRequestStart?: () => void;
  onRequestEnd?: (success: boolean) => void;
};

/**
 * Wrap a stream function with circuit breaker protection.
 *
 * - If the provider is cooling down → throw immediately (no API call)
 * - If the API returns a rate limit error → record cooldown, then re-throw
 * - On success → clear any cooldown
 */
export function wrapStreamFnWithRateLimit(
  streamFn: StreamFn,
  options: RateLimitWrapperOptions,
): StreamFn {
  const provider = options.provider;

  return function circuitBreakerStreamFn(
    model: unknown,
    context: unknown,
    opts?: unknown,
  ): unknown {
    // Circuit breaker check — if cooling down, fail fast
    const cooldownMs = getProviderCooldownMs(provider);
    if (cooldownMs > 0) {
      try {
        options.onRateLimited?.(cooldownMs, "provider_cooling_down");
      } catch {
        // ignore notification errors
      }
      throw new Error(
        `LLM API rate limited for ${provider}: cooling down (${Math.ceil(cooldownMs / 1000)}s remaining).`,
      );
    }

    options.onRequestStart?.();

    try {
      const result = streamFn(model, context, opts);
      // Success — clear any lingering cooldown
      clearProviderCooldown(provider);
      options.onRequestEnd?.(true);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isRateLimitError(errMsg)) {
        const cooldown = parseCooldownFromError(errMsg);
        setProviderCooldown(provider, cooldown);
      }

      options.onRequestEnd?.(false);
      throw err;
    }
  };
}

/**
 * Create a rate-limited stream function wrapper for a specific provider.
 */
export function createRateLimitedStreamFn(
  streamFn: StreamFn,
  provider: string,
  callbacks?: {
    onRateLimited?: (waitMs: number, reason: string) => void;
    onRequestStart?: () => void;
    onRequestEnd?: (success: boolean) => void;
  },
): StreamFn {
  return wrapStreamFnWithRateLimit(streamFn, {
    provider,
    ...callbacks,
  });
}

// Re-export for compatibility with existing imports
export function mapToLlmProvider(provider: string): string {
  return provider.toLowerCase().trim();
}
export function getRateLimiterStats() {
  const stats: Record<string, { cooldownMs: number }> = {};
  for (const [provider, until] of providerCooldowns) {
    stats[provider] = { cooldownMs: Math.max(0, until - Date.now()) };
  }
  return stats;
}
export function getRateLimiterUsageHistory() {
  return [];
}
