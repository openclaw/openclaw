/**
 * Rate Limit Manager - Handles API rate limiting with circuit breaker pattern
 */

import type { Database } from "../db/database.js";
import type { CircuitBreakerRecord } from "../db/database.js";

export type CircuitBreakerState = "closed" | "open" | "half_open";

const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_OPEN_DURATION_MS = 60000;
const CIRCUIT_BREAKER_HALF_OPEN_SUCCESSES = 2;

const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const JITTER_FACTOR = 0.1;

export class RateLimitManager {
  private db: Database;
  private memoryCache: Map<
    string,
    { cooldownUntil: number; failureCount: number; successCount: number }
  >;
  private circuitBreakers: Map<
    string,
    { state: CircuitBreakerState; failureCount: number; lastFailure: number; successCount: number }
  >;

  constructor(db: Database) {
    this.db = db;
    this.memoryCache = new Map();
    this.circuitBreakers = new Map();
    this.loadFromDatabase();
  }

  private loadFromDatabase(): void {
    try {
      const db = this.db.getDb();

      const rateLimits = db.prepare("SELECT * FROM rate_limits").all() as {
        provider: string;
        model: string;
        cooldown_until: string | null;
        failure_count: number;
        success_count: number;
      }[];
      for (const record of rateLimits) {
        const cooldownUntil = record.cooldown_until ? new Date(record.cooldown_until).getTime() : 0;
        this.memoryCache.set(`${record.provider}:${record.model}`, {
          cooldownUntil,
          failureCount: record.failure_count,
          successCount: record.success_count,
        });
      }

      const circuitBreakers = db
        .prepare("SELECT * FROM circuit_breakers")
        .all() as CircuitBreakerRecord[];
      for (const record of circuitBreakers) {
        this.circuitBreakers.set(record.provider, {
          state: record.state,
          failureCount: record.failure_count,
          lastFailure: record.last_failure ? new Date(record.last_failure).getTime() : 0,
          successCount: 0,
        });
      }
    } catch {
      // Tables may not exist yet
    }
  }

  async checkCooldown(provider: string, model: string): Promise<number | null> {
    const cached = this.memoryCache.get(`${provider}:${model}`);

    if (!cached) return null;

    const now = Date.now();
    if (cached.cooldownUntil > now) {
      return cached.cooldownUntil - now;
    }

    return null;
  }

  async recordRequest(provider: string, model: string): Promise<void> {
    this.db.recordRequest(provider, model);
  }

  async handleRateLimit(provider: string, model: string, retryAfterMs?: number): Promise<void> {
    const cooldownMs = retryAfterMs || DEFAULT_BASE_DELAY_MS * 2;
    this.db.recordRateLimit(provider, model, cooldownMs);

    const key = `${provider}:${model}`;
    const cached = this.memoryCache.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.cooldownUntil = Date.now() + cooldownMs;
    cached.failureCount++;
    this.memoryCache.set(key, cached);

    await this.recordFailure(provider, model);
  }

  async recordSuccess(provider: string, model: string): Promise<void> {
    this.db.recordSuccess(provider, model);

    const key = `${provider}:${model}`;
    const cached = this.memoryCache.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.successCount++;
    cached.failureCount = Math.max(0, cached.failureCount - 1);
    this.memoryCache.set(key, cached);

    await this.recordCircuitBreakerSuccess(provider);
  }

  async recordFailure(provider: string, model: string): Promise<void> {
    this.db.recordFailure(provider, model);

    const key = `${provider}:${model}`;
    const cached = this.memoryCache.get(key) || {
      cooldownUntil: 0,
      failureCount: 0,
      successCount: 0,
    };
    cached.failureCount++;
    this.memoryCache.set(key, cached);

    await this.recordCircuitBreakerFailure(provider);
  }

  getCircuitBreakerState(provider: string): CircuitBreakerState {
    const cb = this.circuitBreakers.get(provider);
    if (!cb) return "closed";

    const now = Date.now();

    if (cb.state === "open") {
      if (now - cb.lastFailure > CIRCUIT_BREAKER_OPEN_DURATION_MS) {
        return "half_open";
      }
    }

    return cb.state;
  }

  private async recordCircuitBreakerFailure(provider: string): Promise<void> {
    const now = Date.now();

    let cb = this.circuitBreakers.get(provider);
    if (!cb) {
      cb = { state: "closed", failureCount: 0, lastFailure: 0, successCount: 0 };
      this.circuitBreakers.set(provider, cb);
    }

    cb.failureCount++;
    cb.lastFailure = now;

    if (cb.state === "closed" && cb.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      cb.state = "open";
    } else if (cb.state === "half_open") {
      cb.state = "open";
    }

    this.db.setCircuitBreakerState(provider, cb.state, cb.failureCount);
  }

  private async recordCircuitBreakerSuccess(provider: string): Promise<void> {
    const now = Date.now();

    let cb = this.circuitBreakers.get(provider);
    if (!cb) {
      cb = { state: "closed", failureCount: 0, lastFailure: 0, successCount: 0 };
      this.circuitBreakers.set(provider, cb);
    }

    cb.successCount++;

    if (cb.state === "half_open" && cb.successCount >= CIRCUIT_BREAKER_HALF_OPEN_SUCCESSES) {
      cb.state = "closed";
      cb.failureCount = 0;
      cb.successCount = 0;
    }

    this.db.setCircuitBreakerState(provider, cb.state, cb.failureCount);
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
        message.includes(" circuit breaker")
      );
    }

    return false;
  }

  getRetryDelay(error: unknown, attempt: number): number {
    const baseDelay = DEFAULT_BASE_DELAY_MS;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = exponentialDelay * JITTER_FACTOR * Math.random();
    const delay = Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY_MS);

    if (error && typeof error === "object") {
      const errorObj = error as Record<string, unknown>;
      if (typeof errorObj.retryAfter === "number") {
        return Math.max(delay, errorObj.retryAfter);
      }
    }

    return delay;
  }
}
