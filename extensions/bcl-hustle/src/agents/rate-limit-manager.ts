/**
 * Rate Limit Manager - Agent-level rate limiting with circuit breaker pattern
 *
 * Handles 429 errors with automatic model failover, implements circuit breaker
 * for service isolation, and provides intelligent retry logic with exponential backoff
 */

import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { BCL_CORE_VALUES, type BCLAgentType } from "../types/index.js";

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface RateLimitConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  maxRetries: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerOpenDurationMs: number;
  circuitBreakerHalfOpenSuccesses: number;
}

export interface ModelInfo {
  provider: string;
  model: string;
  priority: number;
}

export interface CircuitBreaker {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailure: number;
  successCount: number;
}

export interface RateLimitStatus {
  provider: string;
  model: string;
  cooldownUntil: number | null;
  failureCount: number;
  successCount: number;
  circuitState: CircuitBreakerState;
  isAvailable: boolean;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.1,
  maxRetries: 3,
  circuitBreakerFailureThreshold: 5,
  circuitBreakerOpenDurationMs: 60000,
  circuitBreakerHalfOpenSuccesses: 2,
};

const DEFAULT_MODELS: ModelInfo[] = [
  { provider: "groq", model: "llama-3.3-70b-versatile", priority: 1 },
  { provider: "groq", model: "mixtral-8x7b-32768", priority: 2 },
  { provider: "groq", model: "gemma2-9b-8192", priority: 3 },
  { provider: "openai", model: "gpt-4o-mini", priority: 4 },
  { provider: "openai", model: "gpt-4o", priority: 5 },
  { provider: "anthropic", model: "claude-3-haiku-20240307", priority: 6 },
  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", priority: 7 },
];

export class RateLimitManager {
  private api: OpenClawPluginApi;
  private config: RateLimitConfig;
  private models: ModelInfo[];
  private rateLimits: Map<string, { cooldownUntil: number; failureCount: number; successCount: number }>;
  private circuitBreakers: Map<string, CircuitBreaker>;
  private currentModelIndex: number;

  constructor(
    api: OpenClawPluginApi,
    config?: Partial<RateLimitConfig>,
    models?: ModelInfo[],
  ) {
    this.api = api;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.models = models || DEFAULT_MODELS;
    this.rateLimits = new Map();
    this.circuitBreakers = new Map();
    this.currentModelIndex = 0;

    if (BCL_CORE_VALUES.circuit_breaker_enabled) {
      this.initializeCircuitBreakers();
    }

    this.api.logger.info("RateLimitManager: Initialized", {
      modelCount: this.models.length,
      config: this.config,
      autoFailover: BCL_CORE_VALUES.auto_model_failover,
    });
  }

  private initializeCircuitBreakers(): void {
    for (const model of this.models) {
      const key = `${model.provider}:${model.model}`;
      this.circuitBreakers.set(key, {
        state: "closed",
        failureCount: 0,
        lastFailure: 0,
        successCount: 0,
      });
    }
  }

  async handleRateLimit(provider: string, model: string, retryAfterMs?: number): Promise<void> {
    const cooldownMs = retryAfterMs || this.config.baseDelayMs * 2;
    const key = `${provider}:${model}`;

    const cached = this.rateLimits.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.cooldownUntil = Date.now() + cooldownMs;
    cached.failureCount++;
    this.rateLimits.set(key, cached);

    await this.recordFailure(provider, model);

    this.api.logger.warn(`RateLimitManager: Rate limit hit for ${key}, cooldown: ${cooldownMs}ms`, {
      provider,
      model,
      cooldownMs,
      failureCount: cached.failureCount,
    });

    if (BCL_CORE_VALUES.auto_model_failover) {
      await this.failoverModel(provider, model);
    }
  }

  async failoverModel(currentProvider: string, currentModel: string): Promise<ModelInfo | null> {
    const currentIndex = this.models.findIndex(
      (m) => m.provider === currentProvider && m.model === currentModel,
    );

    if (currentIndex === -1 || currentIndex >= this.models.length - 1) {
      this.api.logger.error("RateLimitManager: No fallback models available", {
        currentProvider,
        currentModel,
      });
      return null;
    }

    const fallbackIndex = currentIndex + 1;
    const fallback = this.models[fallbackIndex];

    const fallbackKey = `${fallback.provider}:${fallback.model}`;
    const fallbackCircuit = this.circuitBreakers.get(fallbackKey);

    if (fallbackCircuit && fallbackCircuit.state === "open") {
      this.api.logger.warn(`RateLimitManager: Skipping fallback model ${fallbackKey}, circuit open`);
      return this.failoverModel(fallback.provider, fallback.model);
    }

    this.currentModelIndex = fallbackIndex;

    this.api.logger.info(`RateLimitManager: Failing over from ${currentProvider}:${currentModel} to ${fallbackKey}`, {
      from: `${currentProvider}:${currentModel}`,
      to: fallbackKey,
      newIndex: fallbackIndex,
    });

    return fallback;
  }

  getCircuitState(provider: string, model: string): CircuitBreakerState {
    const key = `${provider}:${model}`;
    const cb = this.circuitBreakers.get(key);

    if (!cb) return "closed";

    const now = Date.now();

    if (cb.state === "open") {
      if (now - cb.lastFailure > this.config.circuitBreakerOpenDurationMs) {
        return "half_open";
      }
    }

    return cb.state;
  }

  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    provider?: string,
    model?: string,
  ): Promise<T> {
    let attempt = 0;
    let lastError: Error | unknown;

    while (attempt < this.config.maxRetries) {
      attempt++;

      try {
        const result = await fn();

        if (provider && model) {
          await this.recordSuccess(provider, model);
        }

        if (attempt > 1) {
          this.api.logger.info(`RateLimitManager: Retry succeeded on attempt ${attempt}`);
        }

        return result;
      } catch (error) {
        lastError = error;

        const isRateLimit = this.shouldRetry(error);

        if (!isRateLimit) {
          this.api.logger.error(`RateLimitManager: Non-retryable error`, error);
          throw error;
        }

        const delay = this.getRetryDelay(error, attempt);

        this.api.logger.warn(`RateLimitManager: Retry attempt ${attempt}/${this.config.maxRetries} after ${delay}ms`, {
          attempt,
          maxRetries: this.config.maxRetries,
          delay,
          error: error instanceof Error ? error.message : String(error),
        });

        if (provider && model) {
          const retryAfter = this.extractRetryAfter(error);
          await this.handleRateLimit(provider, model, retryAfter);
        }

        if (attempt < this.config.maxRetries) {
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  getRateLimitStatus(provider: string, model: string): RateLimitStatus {
    const key = `${provider}:${model}`;
    const cached = this.rateLimits.get(key);
    const circuitState = this.getCircuitState(provider, model);

    const now = Date.now();
    const cooldownUntil = cached?.cooldownUntil || null;
    const isAvailable = circuitState !== "open" && (!cooldownUntil || cooldownUntil <= now);

    return {
      provider,
      model,
      cooldownUntil,
      failureCount: cached?.failureCount || 0,
      successCount: cached?.successCount || 0,
      circuitState,
      isAvailable,
    };
  }

  getAllRateLimitStatuses(): RateLimitStatus[] {
    const statuses: RateLimitStatus[] = [];

    for (const model of this.models) {
      statuses.push(this.getRateLimitStatus(model.provider, model.model));
    }

    return statuses;
  }

  getCurrentModel(): ModelInfo {
    return this.models[this.currentModelIndex];
  }

  setModelPriority(provider: string, model: string, priority: number): void {
    const index = this.models.findIndex(
      (m) => m.provider === provider && m.model === model,
    );

    if (index !== -1) {
      this.models[index].priority = priority;
      this.models.sort((a, b) => a.priority - b.priority);

      this.api.logger.info(`RateLimitManager: Updated model priority`, {
        provider,
        model,
        newPriority: priority,
      });
    }
  }

  private async recordSuccess(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;

    const cached = this.rateLimits.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.successCount++;
    cached.failureCount = Math.max(0, cached.failureCount - 1);
    this.rateLimits.set(key, cached);

    await this.recordCircuitBreakerSuccess(provider, model);
  }

  private async recordFailure(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;

    const cached = this.rateLimits.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.failureCount++;
    this.rateLimits.set(key, cached);

    await this.recordCircuitBreakerFailure(provider, model);
  }

  private async recordCircuitBreakerFailure(provider: string, model: string): Promise<void> {
    if (!BCL_CORE_VALUES.circuit_breaker_enabled) return;

    const now = Date.now();
    const key = `${provider}:${model}`;

    let cb = this.circuitBreakers.get(key);
    if (!cb) {
      cb = { state: "closed", failureCount: 0, lastFailure: 0, successCount: 0 };
      this.circuitBreakers.set(key, cb);
    }

    cb.failureCount++;
    cb.lastFailure = now;

    if (cb.state === "closed" && cb.failureCount >= this.config.circuitBreakerFailureThreshold) {
      cb.state = "open";
      this.api.logger.warn(`RateLimitManager: Circuit breaker opened for ${key}`, {
        failureCount: cb.failureCount,
        threshold: this.config.circuitBreakerFailureThreshold,
      });
    } else if (cb.state === "half_open") {
      cb.state = "open";
    }
  }

  private async recordCircuitBreakerSuccess(provider: string, model: string): Promise<void> {
    if (!BCL_CORE_VALUES.circuit_breaker_enabled) return;

    const key = `${provider}:${model}`;

    let cb = this.circuitBreakers.get(key);
    if (!cb) {
      cb = { state: "closed", failureCount: 0, lastFailure: 0, successCount: 0 };
      this.circuitBreakers.set(key, cb);
    }

    cb.successCount++;

    if (cb.state === "half_open" && cb.successCount >= this.config.circuitBreakerHalfOpenSuccesses) {
      cb.state = "closed";
      cb.failureCount = 0;
      cb.successCount = 0;

      this.api.logger.info(`RateLimitManager: Circuit breaker closed for ${key}`);
    }
  }

  shouldRetry(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    const errorObj = error as Record<string, unknown>;

    if (typeof errorObj.status === "number") {
      const status = errorObj.status;
      return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    }

    if (typeof errorObj.message === "string") {
      const message = errorObj.message.toLowerCase();
      return (
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("circuit breaker") ||
        message.includes("429")
      );
    }

    return false;
  }

  getRetryDelay(error: unknown, attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = exponentialDelay * this.config.jitterFactor * Math.random();
    const delay = Math.min(exponentialDelay + jitter, this.config.maxDelayMs);

    const retryAfter = this.extractRetryAfter(error);
    if (retryAfter) {
      return Math.max(delay, retryAfter);
    }

    return delay;
  }

  private extractRetryAfter(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;

    const errorObj = error as Record<string, unknown>;

    if (typeof errorObj.retryAfter === "number") {
      return errorObj.retryAfter;
    }

    if (typeof errorObj.headers === "object" && errorObj.headers !== null) {
      const headers = errorObj.headers as Record<string, unknown>;
      const retryAfter = headers["retry-after"];
      if (typeof retryAfter === "string") {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) {
          return parsed * 1000;
        }
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  resetRateLimits(provider?: string, model?: string): void {
    if (provider && model) {
      const key = `${provider}:${model}`;
      this.rateLimits.delete(key);

      const cb = this.circuitBreakers.get(key);
      if (cb) {
        cb.state = "closed";
        cb.failureCount = 0;
        cb.successCount = 0;
      }

      this.api.logger.info(`RateLimitManager: Reset rate limits for ${key}`);
    } else {
      this.rateLimits.clear();

      for (const key of this.circuitBreakers.keys()) {
        const cb = this.circuitBreakers.get(key);
        if (cb) {
          cb.state = "closed";
          cb.failureCount = 0;
          cb.successCount = 0;
        }
      }

      this.api.logger.info("RateLimitManager: Reset all rate limits");
    }
  }

  getModels(): ModelInfo[] {
    return [...this.models];
  }

  getConfig(): RateLimitConfig {
    return { ...this.config };
  }
}

export function createRateLimitManager(
  api: OpenClawPluginApi,
  config?: Partial<RateLimitConfig>,
  models?: ModelInfo[],
): RateLimitManager {
  return new RateLimitManager(api, config, models);
}
