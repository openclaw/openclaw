/**
 * Per-provider request rate limiter (sliding window).
 *
 * Tracks requests per minute (RPM) per provider and returns whether a new
 * request is allowed. When the limit is reached, returns the number of
 * milliseconds to wait before the next request will be accepted.
 *
 * This is a proactive rate limiter — it prevents requests from being sent
 * when we know they'll hit the provider's rate limit, avoiding the reactive
 * cooldown/backoff path entirely.
 */

export type ProviderRateLimitConfig = {
  /** Requests per minute. 0 = unlimited. */
  rpm?: number;
};

export type ProviderRateLimitResult = {
  allowed: boolean;
  /** Milliseconds to wait before retrying (0 if allowed). */
  retryAfterMs: number;
  /** Remaining requests in the current window. */
  remaining: number;
};

type ProviderWindow = {
  /** Timestamps of recent requests within the sliding window. */
  timestamps: number[];
};

const DEFAULT_WINDOW_MS = 60_000; // 1 minute

/**
 * Default RPM limits by provider. Conservative defaults — providers with
 * higher actual limits can be overridden via configuration.
 */
const DEFAULT_RPM_BY_PROVIDER: Record<string, number> = {
  anthropic: 50,
  openai: 60,
  "openai-codex": 60,
  google: 60,
};

export class ProviderRateLimiter {
  private readonly windows = new Map<string, ProviderWindow>();
  private readonly windowMs: number;
  private readonly configOverrides: Record<string, ProviderRateLimitConfig>;
  private readonly nowFn: () => number;

  constructor(params?: {
    windowMs?: number;
    /** Per-provider configuration overrides. */
    config?: Record<string, ProviderRateLimitConfig>;
    now?: () => number;
  }) {
    this.windowMs = params?.windowMs ?? DEFAULT_WINDOW_MS;
    this.configOverrides = params?.config ?? {};
    this.nowFn = params?.now ?? Date.now;
  }

  private getRpm(provider: string): number {
    const override = this.configOverrides[provider]?.rpm;
    if (typeof override === "number" && override >= 0) {
      return override;
    }
    return DEFAULT_RPM_BY_PROVIDER[provider] ?? 0; // 0 = unlimited
  }

  private getOrCreateWindow(provider: string): ProviderWindow {
    let win = this.windows.get(provider);
    if (!win) {
      win = { timestamps: [] };
      this.windows.set(provider, win);
    }
    return win;
  }

  /** Prune timestamps outside the sliding window. */
  private prune(win: ProviderWindow, now: number): void {
    const cutoff = now - this.windowMs;
    // Fast path: if the first timestamp is within window, nothing to prune
    if (win.timestamps.length > 0 && win.timestamps[0] > cutoff) {
      return;
    }
    win.timestamps = win.timestamps.filter((ts) => ts > cutoff);
  }

  /**
   * Check whether a request to the given provider is allowed.
   * If allowed, records the request. If not, returns the delay.
   */
  consume(provider: string): ProviderRateLimitResult {
    const rpm = this.getRpm(provider);
    if (rpm <= 0) {
      // Unlimited — always allow
      return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
    }

    const now = this.nowFn();
    const win = this.getOrCreateWindow(provider);
    this.prune(win, now);

    if (win.timestamps.length >= rpm) {
      // Window full — calculate when the oldest request will expire
      const oldest = win.timestamps[0];
      const retryAfterMs = Math.max(1, oldest + this.windowMs - now);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    win.timestamps.push(now);
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, rpm - win.timestamps.length),
    };
  }

  /** Check without consuming a slot. */
  peek(provider: string): ProviderRateLimitResult {
    const rpm = this.getRpm(provider);
    if (rpm <= 0) {
      return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
    }

    const now = this.nowFn();
    const win = this.getOrCreateWindow(provider);
    this.prune(win, now);

    if (win.timestamps.length >= rpm) {
      const oldest = win.timestamps[0];
      const retryAfterMs = Math.max(1, oldest + this.windowMs - now);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, rpm - win.timestamps.length),
    };
  }

  /** Reset all state for a provider. */
  reset(provider: string): void {
    this.windows.delete(provider);
  }

  /** Reset all state. */
  resetAll(): void {
    this.windows.clear();
  }
}

/** Singleton instance for the process. */
let globalInstance: ProviderRateLimiter | null = null;

export function getProviderRateLimiter(params?: {
  config?: Record<string, ProviderRateLimitConfig>;
}): ProviderRateLimiter {
  if (!globalInstance) {
    globalInstance = new ProviderRateLimiter({ config: params?.config });
  }
  return globalInstance;
}

/** Reset the global instance (for testing). */
export function resetProviderRateLimiter(): void {
  globalInstance = null;
}
