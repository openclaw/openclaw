/**
 * SECURITY: LLM API Rate Limiter
 *
 * Implements proactive rate limiting for cloud LLM APIs to prevent:
 * 1. Exceeding provider rate limits (429 errors)
 * 2. Unexpected billing charges from runaway token usage
 * 3. Denial of service from excessive API calls
 *
 * Features:
 * - Token bucket algorithm with configurable limits per provider
 * - Request queueing with priority support
 * - Exponential backoff on rate limit errors
 * - Global and per-provider token budgets
 * - Usage tracking for billing protection
 */

export type LlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "bedrock"
  | "github-copilot"
  | "minimax"
  | "moonshot"
  | "kimi"
  | "qwen"
  | "venice"
  | "ollama"
  | "custom";

export type RateLimitConfig = {
  /** Requests per minute limit */
  requestsPerMinute: number;
  /** Tokens per minute limit (input + output combined) */
  tokensPerMinute: number;
  /** Tokens per day limit (for budget protection) */
  tokensPerDay: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
  /** Base backoff delay in ms after rate limit error */
  backoffBaseMs: number;
  /** Maximum backoff delay in ms */
  backoffMaxMs: number;
  /** Whether this provider is enabled */
  enabled: boolean;
};

type TokenBucket = {
  /** Current available tokens in bucket */
  tokens: number;
  /** Last refill timestamp */
  lastRefill: number;
  /** Tokens used today */
  tokensUsedToday: number;
  /** Day start timestamp for daily tracking */
  dayStart: number;
  /** Current backoff level (increases with consecutive errors) */
  backoffLevel: number;
  /** When current backoff expires */
  backoffUntil: number;
  /** Number of requests currently in flight */
  inFlight: number;
  /** Request counter for RPM tracking */
  requestsThisMinute: number;
  /** Minute start timestamp */
  minuteStart: number;
};

type QueuedRequest = {
  id: string;
  provider: LlmProvider;
  estimatedTokens: number;
  priority: number;
  timestamp: number;
  resolve: (result: RateLimitCheckResult) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
};

export type RateLimitCheckResult = {
  allowed: boolean;
  waitMs?: number;
  reason?: string;
  tokensRemaining?: number;
  requestsRemaining?: number;
};

export type UsageRecord = {
  requestId: string;
  provider: LlmProvider;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
  success: boolean;
  errorType?: "rate_limit" | "auth" | "billing" | "timeout" | "other";
};

// Default rate limits per provider (conservative defaults)
const DEFAULT_PROVIDER_LIMITS: Record<LlmProvider, RateLimitConfig> = {
  anthropic: {
    requestsPerMinute: 50,
    tokensPerMinute: 30000,
    tokensPerDay: 5000000,
    maxConcurrent: 5,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: false,
  },
  openai: {
    requestsPerMinute: 60,
    tokensPerMinute: 90000,
    tokensPerDay: 2000000,
    maxConcurrent: 10,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: false,
  },
  google: {
    requestsPerMinute: 60,
    tokensPerMinute: 60000,
    tokensPerDay: 1500000,
    maxConcurrent: 5,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: false,
  },
  bedrock: {
    requestsPerMinute: 50,
    tokensPerMinute: 50000,
    tokensPerDay: 1000000,
    maxConcurrent: 5,
    backoffBaseMs: 2000,
    backoffMaxMs: 120000,
    enabled: true,
  },
  "github-copilot": {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 2000,
    backoffMaxMs: 120000,
    enabled: true,
  },
  minimax: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
  moonshot: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
  kimi: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
  qwen: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
  venice: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
  ollama: {
    // Local - higher limits
    requestsPerMinute: 120,
    tokensPerMinute: 500000,
    tokensPerDay: 10000000,
    maxConcurrent: 10,
    backoffBaseMs: 100,
    backoffMaxMs: 5000,
    enabled: true,
  },
  custom: {
    requestsPerMinute: 30,
    tokensPerMinute: 30000,
    tokensPerDay: 500000,
    maxConcurrent: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000,
    enabled: true,
  },
};

// Global limits across all providers
const DEFAULT_GLOBAL_LIMITS = {
  tokensPerMinute: 200000,
  tokensPerDay: 5000000,
  maxConcurrentTotal: 20,
  requestQueueMaxSize: 100,
  requestTimeoutMs: 300000, // 5 minutes max wait in queue
};

/**
 * LLM Rate Limiter with token bucket algorithm and request queueing.
 */
export class LlmRateLimiter {
  private buckets = new Map<LlmProvider, TokenBucket>();
  private providerLimits = new Map<LlmProvider, RateLimitConfig>();
  private requestQueue: QueuedRequest[] = [];
  private globalTokensThisMinute = 0;
  private globalMinuteStart = Date.now();
  private globalTokensToday = 0;
  private globalDayStart = this.getDayStart();
  private totalInFlight = 0;
  private processQueueTimer: NodeJS.Timeout | null = null;
  private globalLimits = { ...DEFAULT_GLOBAL_LIMITS };
  private usageHistory: UsageRecord[] = [];
  private maxUsageHistorySize = 10000;

  constructor(
    providerOverrides?: Partial<Record<LlmProvider, Partial<RateLimitConfig>>>,
    globalOverrides?: Partial<typeof DEFAULT_GLOBAL_LIMITS>,
  ) {
    // Initialize provider limits with defaults + overrides
    for (const [provider, defaults] of Object.entries(DEFAULT_PROVIDER_LIMITS)) {
      const overrides = providerOverrides?.[provider as LlmProvider] ?? {};
      this.providerLimits.set(provider as LlmProvider, { ...defaults, ...overrides });
    }

    // Apply global overrides
    if (globalOverrides) {
      this.globalLimits = { ...this.globalLimits, ...globalOverrides };
    }

    // Start queue processor
    this.startQueueProcessor();
  }

  /**
   * Check if a request can proceed immediately or needs to wait.
   * @param provider - The LLM provider
   * @param estimatedTokens - Estimated tokens for the request
   * @returns Rate limit check result
   */
  check(provider: LlmProvider, estimatedTokens: number): RateLimitCheckResult {
    const limits = this.providerLimits.get(provider);
    if (!limits) {
      return { allowed: true }; // Unknown provider - allow by default
    }

    if (!limits.enabled) {
      return { allowed: false, reason: "provider_disabled" };
    }

    const bucket = this.getOrCreateBucket(provider);
    const now = Date.now();

    // Check backoff
    if (bucket.backoffUntil > now) {
      return {
        allowed: false,
        waitMs: bucket.backoffUntil - now,
        reason: "backoff_active",
      };
    }

    // Refill token bucket
    this.refillBucket(bucket, limits);
    this.refillGlobalCounters();

    // Check concurrent requests
    if (bucket.inFlight >= limits.maxConcurrent) {
      return {
        allowed: false,
        waitMs: 1000, // Wait 1 second and retry
        reason: "max_concurrent_reached",
      };
    }

    if (this.totalInFlight >= this.globalLimits.maxConcurrentTotal) {
      return {
        allowed: false,
        waitMs: 1000,
        reason: "global_max_concurrent_reached",
      };
    }

    // Check RPM
    if (bucket.requestsThisMinute >= limits.requestsPerMinute) {
      const waitMs = 60000 - (now - bucket.minuteStart);
      return {
        allowed: false,
        waitMs: Math.max(waitMs, 1000),
        reason: "rpm_exceeded",
        requestsRemaining: 0,
      };
    }

    // Check token bucket (TPM)
    if (bucket.tokens < estimatedTokens) {
      const refillRate = limits.tokensPerMinute / 60000;
      const waitMs = Math.ceil((estimatedTokens - bucket.tokens) / refillRate);
      return {
        allowed: false,
        waitMs: Math.min(waitMs, 60000),
        reason: "tpm_exceeded",
        tokensRemaining: Math.floor(bucket.tokens),
      };
    }

    // Check daily limit
    if (bucket.tokensUsedToday + estimatedTokens > limits.tokensPerDay) {
      return {
        allowed: false,
        waitMs: this.getTimeUntilTomorrow(),
        reason: "daily_limit_exceeded",
        tokensRemaining: Math.max(0, limits.tokensPerDay - bucket.tokensUsedToday),
      };
    }

    // Check global limits
    if (this.globalTokensThisMinute + estimatedTokens > this.globalLimits.tokensPerMinute) {
      const waitMs = 60000 - (now - this.globalMinuteStart);
      return {
        allowed: false,
        waitMs: Math.max(waitMs, 1000),
        reason: "global_tpm_exceeded",
      };
    }

    if (this.globalTokensToday + estimatedTokens > this.globalLimits.tokensPerDay) {
      return {
        allowed: false,
        waitMs: this.getTimeUntilTomorrow(),
        reason: "global_daily_limit_exceeded",
      };
    }

    return {
      allowed: true,
      tokensRemaining: Math.floor(bucket.tokens - estimatedTokens),
      requestsRemaining: limits.requestsPerMinute - bucket.requestsThisMinute - 1,
    };
  }

  /**
   * Reserve capacity for a request (call before making API call).
   */
  reserve(provider: LlmProvider, estimatedTokens: number): boolean {
    const checkResult = this.check(provider, estimatedTokens);
    if (!checkResult.allowed) {
      return false;
    }

    const bucket = this.getOrCreateBucket(provider);
    bucket.tokens -= estimatedTokens;
    bucket.requestsThisMinute++;
    bucket.inFlight++;
    this.totalInFlight++;
    this.globalTokensThisMinute += estimatedTokens;

    return true;
  }

  /**
   * Release capacity after request completes.
   */
  release(
    provider: LlmProvider,
    actualTokens: number,
    estimatedTokens: number,
    success: boolean,
    errorType?: UsageRecord["errorType"],
  ): void {
    const bucket = this.getOrCreateBucket(provider);

    // Adjust token count based on actual vs estimated
    const tokenDiff = estimatedTokens - actualTokens;
    if (tokenDiff > 0) {
      bucket.tokens += tokenDiff; // Refund unused estimate
    } else if (tokenDiff < 0) {
      bucket.tokens += tokenDiff; // Deduct extra tokens used
    }

    // Track daily usage
    bucket.tokensUsedToday += actualTokens;
    this.globalTokensToday += actualTokens;

    // Decrease in-flight counters
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    this.totalInFlight = Math.max(0, this.totalInFlight - 1);

    // Handle errors
    if (!success && errorType === "rate_limit") {
      this.applyBackoff(provider);
    } else if (success) {
      // Reset backoff on success
      bucket.backoffLevel = 0;
    }

    // Record usage
    this.recordUsage({
      requestId: `${provider}-${Date.now()}`,
      provider,
      inputTokens: Math.floor(actualTokens * 0.7), // Estimate split
      outputTokens: Math.floor(actualTokens * 0.3),
      timestamp: Date.now(),
      success,
      errorType,
    });

    // Process queued requests
    this.processQueue();
  }

  /**
   * Queue a request to wait for rate limit capacity.
   * @returns Promise that resolves when request can proceed
   */
  async waitForCapacity(
    provider: LlmProvider,
    estimatedTokens: number,
    priority = 0,
  ): Promise<RateLimitCheckResult> {
    // Try immediate check first
    const checkResult = this.check(provider, estimatedTokens);
    if (checkResult.allowed) {
      return checkResult;
    }

    // Check queue size limit
    if (this.requestQueue.length >= this.globalLimits.requestQueueMaxSize) {
      return {
        allowed: false,
        reason: "queue_full",
      };
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      const id = `${provider}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const request: QueuedRequest = {
        id,
        provider,
        estimatedTokens,
        priority,
        timestamp: Date.now(),
        resolve,
        reject,
      };

      // Set timeout
      request.timeoutId = setTimeout(() => {
        this.removeFromQueue(id);
        resolve({
          allowed: false,
          reason: "queue_timeout",
        });
      }, this.globalLimits.requestTimeoutMs);

      // Insert by priority (higher priority first)
      const insertIndex = this.requestQueue.findIndex((r) => r.priority < priority);
      if (insertIndex === -1) {
        this.requestQueue.push(request);
      } else {
        this.requestQueue.splice(insertIndex, 0, request);
      }
    });
  }

  /**
   * Apply exponential backoff after a rate limit error.
   */
  private applyBackoff(provider: LlmProvider): void {
    const bucket = this.getOrCreateBucket(provider);
    const limits = this.providerLimits.get(provider) ?? DEFAULT_PROVIDER_LIMITS.custom;

    bucket.backoffLevel++;
    const backoffMs = Math.min(
      limits.backoffBaseMs * Math.pow(2, bucket.backoffLevel - 1),
      limits.backoffMaxMs,
    );
    bucket.backoffUntil = Date.now() + backoffMs;
  }

  /**
   * Get or create a token bucket for a provider.
   */
  private getOrCreateBucket(provider: LlmProvider): TokenBucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      const limits = this.providerLimits.get(provider) ?? DEFAULT_PROVIDER_LIMITS.custom;
      bucket = {
        tokens: limits.tokensPerMinute,
        lastRefill: Date.now(),
        tokensUsedToday: 0,
        dayStart: this.getDayStart(),
        backoffLevel: 0,
        backoffUntil: 0,
        inFlight: 0,
        requestsThisMinute: 0,
        minuteStart: Date.now(),
      };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  /**
   * Refill the token bucket based on elapsed time.
   */
  private refillBucket(bucket: TokenBucket, limits: RateLimitConfig): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;

    // Refill tokens based on elapsed time
    const refillRate = limits.tokensPerMinute / 60000; // tokens per ms
    const refillAmount = elapsed * refillRate;
    bucket.tokens = Math.min(limits.tokensPerMinute, bucket.tokens + refillAmount);
    bucket.lastRefill = now;

    // Reset minute counter if needed
    if (now - bucket.minuteStart >= 60000) {
      bucket.requestsThisMinute = 0;
      bucket.minuteStart = now;
    }

    // Reset daily counter if new day
    const dayStart = this.getDayStart();
    if (dayStart !== bucket.dayStart) {
      bucket.tokensUsedToday = 0;
      bucket.dayStart = dayStart;
    }
  }

  /**
   * Refill global counters.
   */
  private refillGlobalCounters(): void {
    const now = Date.now();

    // Reset minute counter
    if (now - this.globalMinuteStart >= 60000) {
      this.globalTokensThisMinute = 0;
      this.globalMinuteStart = now;
    }

    // Reset daily counter
    const dayStart = this.getDayStart();
    if (dayStart !== this.globalDayStart) {
      this.globalTokensToday = 0;
      this.globalDayStart = dayStart;
    }
  }

  /**
   * Process queued requests.
   */
  private processQueue(): void {
    const now = Date.now();

    // Process requests in order (already sorted by priority)
    for (let i = 0; i < this.requestQueue.length; ) {
      const request = this.requestQueue[i];
      const checkResult = this.check(request.provider, request.estimatedTokens);

      if (checkResult.allowed) {
        // Remove from queue
        this.requestQueue.splice(i, 1);
        if (request.timeoutId) {
          clearTimeout(request.timeoutId);
        }
        request.resolve(checkResult);
        // Don't increment i since we removed an element
      } else {
        // Check if request has been waiting too long
        if (now - request.timestamp > this.globalLimits.requestTimeoutMs) {
          this.requestQueue.splice(i, 1);
          if (request.timeoutId) {
            clearTimeout(request.timeoutId);
          }
          request.resolve({ allowed: false, reason: "queue_timeout" });
        } else {
          i++;
        }
      }
    }
  }

  /**
   * Start periodic queue processing.
   */
  private startQueueProcessor(): void {
    if (this.processQueueTimer) {
      return;
    }
    this.processQueueTimer = setInterval(() => {
      this.processQueue();
    }, 1000);
    this.processQueueTimer.unref();
  }

  /**
   * Remove a request from the queue by ID.
   */
  private removeFromQueue(id: string): void {
    const index = this.requestQueue.findIndex((r) => r.id === id);
    if (index !== -1) {
      const request = this.requestQueue[index];
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      this.requestQueue.splice(index, 1);
    }
  }

  /**
   * Record usage for history tracking.
   */
  private recordUsage(record: UsageRecord): void {
    this.usageHistory.push(record);

    // Trim history if too large
    if (this.usageHistory.length > this.maxUsageHistorySize) {
      this.usageHistory = this.usageHistory.slice(-this.maxUsageHistorySize / 2);
    }
  }

  /**
   * Get the start of the current day (midnight local time).
   */
  private getDayStart(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  /**
   * Get time until tomorrow (next day start).
   */
  private getTimeUntilTomorrow(): number {
    const now = Date.now();
    const tomorrow = this.getDayStart() + 24 * 60 * 60 * 1000;
    return tomorrow - now;
  }

  /**
   * Get current usage statistics.
   */
  getStats(): {
    providers: Record<
      string,
      {
        tokensRemaining: number;
        tokensUsedToday: number;
        requestsThisMinute: number;
        inFlight: number;
        backoffUntil: number;
      }
    >;
    global: {
      tokensThisMinute: number;
      tokensToday: number;
      totalInFlight: number;
      queueLength: number;
    };
  } {
    const providers: Record<
      string,
      {
        tokensRemaining: number;
        tokensUsedToday: number;
        requestsThisMinute: number;
        inFlight: number;
        backoffUntil: number;
        dailyLimit: number;
        dailyUsagePercent: number;
      }
    > = {};

    for (const [provider, bucket] of this.buckets) {
      const limits = this.providerLimits.get(provider);
      providers[provider] = {
        tokensRemaining: Math.floor(bucket.tokens),
        tokensUsedToday: bucket.tokensUsedToday,
        requestsThisMinute: bucket.requestsThisMinute,
        inFlight: bucket.inFlight,
        backoffUntil: bucket.backoffUntil,
        dailyLimit: limits?.tokensPerDay ?? 0,
        dailyUsagePercent: limits
          ? Math.round((bucket.tokensUsedToday / limits.tokensPerDay) * 100)
          : 0,
      };
    }

    return {
      providers,
      global: {
        tokensThisMinute: this.globalTokensThisMinute,
        tokensToday: this.globalTokensToday,
        totalInFlight: this.totalInFlight,
        queueLength: this.requestQueue.length,
      },
    };
  }

  /**
   * Get recent usage history.
   */
  getUsageHistory(limit = 100): UsageRecord[] {
    return this.usageHistory.slice(-limit);
  }

  /**
   * Update provider limits at runtime.
   */
  updateProviderLimits(provider: LlmProvider, limits: Partial<RateLimitConfig>): void {
    const current = this.providerLimits.get(provider) ?? DEFAULT_PROVIDER_LIMITS.custom;
    this.providerLimits.set(provider, { ...current, ...limits });
  }

  /**
   * Enable or disable a provider.
   */
  setProviderEnabled(provider: LlmProvider, enabled: boolean): void {
    this.updateProviderLimits(provider, { enabled });
  }

  /**
   * Stop the rate limiter and clean up.
   */
  stop(): void {
    if (this.processQueueTimer) {
      clearInterval(this.processQueueTimer);
      this.processQueueTimer = null;
    }

    // Reject all queued requests
    for (const request of this.requestQueue) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.resolve({ allowed: false, reason: "rate_limiter_stopped" });
    }
    this.requestQueue = [];
  }
}

// Singleton instance
let llmRateLimiter: LlmRateLimiter | null = null;

/**
 * Get the singleton LLM rate limiter instance.
 */
export function getLlmRateLimiter(): LlmRateLimiter {
  if (!llmRateLimiter) {
    llmRateLimiter = new LlmRateLimiter();
  }
  return llmRateLimiter;
}

/**
 * Check if an LLM API request is allowed.
 */
export function checkLlmRateLimit(
  provider: LlmProvider,
  estimatedTokens: number,
): RateLimitCheckResult {
  return getLlmRateLimiter().check(provider, estimatedTokens);
}

/**
 * Reserve capacity for an LLM API request.
 */
export function reserveLlmCapacity(provider: LlmProvider, estimatedTokens: number): boolean {
  return getLlmRateLimiter().reserve(provider, estimatedTokens);
}

/**
 * Release capacity after an LLM API request completes.
 */
export function releaseLlmCapacity(
  provider: LlmProvider,
  actualTokens: number,
  estimatedTokens: number,
  success: boolean,
  errorType?: UsageRecord["errorType"],
): void {
  getLlmRateLimiter().release(provider, actualTokens, estimatedTokens, success, errorType);
}

/**
 * Wait for rate limit capacity to become available.
 */
export function waitForLlmCapacity(
  provider: LlmProvider,
  estimatedTokens: number,
  priority = 0,
): Promise<RateLimitCheckResult> {
  return getLlmRateLimiter().waitForCapacity(provider, estimatedTokens, priority);
}
