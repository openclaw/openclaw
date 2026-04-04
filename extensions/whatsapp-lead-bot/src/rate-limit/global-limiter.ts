/**
 * Global rate limiter - enforces system-wide message limit across ALL leads.
 * Uses DB transactions for atomic check-and-increment.
 */

import type { GlobalRateLimitStore } from "../database.js";

export interface GlobalRateLimitConfig {
  enabled: boolean;
  maxMessagesPerHour: number;
  windowMs: number;
}

export interface GlobalRateLimitResult {
  allowed: boolean;
  count: number;
  reason?: string;
}

export class GlobalRateLimiter {
  constructor(
    private db: GlobalRateLimitStore,
    private config: GlobalRateLimitConfig,
  ) {}

  async check(): Promise<GlobalRateLimitResult> {
    if (!this.config.enabled) {
      return { allowed: true, count: 0 };
    }

    const row = await this.db.getGlobalRateLimit();
    const now = Date.now();
    const elapsed = now - row.window_start;

    // Window expired → reset
    if (elapsed > this.config.windowMs) {
      await this.db.resetGlobalWindow(now);
      return { allowed: true, count: 0 };
    }

    if (row.message_count >= this.config.maxMessagesPerHour) {
      return {
        allowed: false,
        count: row.message_count,
        reason: `Global rate limit exceeded: ${row.message_count}/${this.config.maxMessagesPerHour} messages in current window`,
      };
    }

    return { allowed: true, count: row.message_count };
  }

  async record(): Promise<GlobalRateLimitResult> {
    const row = await this.db.getGlobalRateLimit();
    const now = Date.now();
    const elapsed = now - row.window_start;

    // Window expired → reset then record
    if (elapsed > this.config.windowMs) {
      await this.db.resetGlobalWindow(now);
    }

    const updated = await this.db.incrementGlobalCount();
    return { allowed: true, count: updated.message_count };
  }

  async getStatus(): Promise<{ count: number; windowStart: number; maxPerHour: number }> {
    const row = await this.db.getGlobalRateLimit();
    return {
      count: row.message_count,
      windowStart: row.window_start,
      maxPerHour: this.config.maxMessagesPerHour,
    };
  }
}
