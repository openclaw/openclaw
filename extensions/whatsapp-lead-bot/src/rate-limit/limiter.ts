/**
 * Rate limiter - tracks message frequency per lead
 */

import type { RateLimitStore } from "../database.js";

export interface RateLimitConfig {
  enabled: boolean;
  messagesPerHour: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

export class RateLimiter {
  constructor(
    private db: RateLimitStore,
    private config: RateLimitConfig,
  ) {}

  async checkLimit(leadId: number): Promise<RateLimitResult> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const lead = await this.db.getLeadById(leadId);
    if (!lead) {
      return { allowed: true };
    }

    const now = Date.now();
    const windowStart = lead.rate_limit_window_start || now;
    const windowElapsed = now - windowStart;

    // Reset window if expired
    if (windowElapsed > this.config.windowMs) {
      await this.db.updateRateLimitWindow(leadId, now);
      await this.db.updateRateLimitCount(leadId, 0);
      return { allowed: true };
    }

    // Check if limit exceeded
    if (lead.rate_limit_count >= this.config.messagesPerHour) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${lead.rate_limit_count} messages in ${Math.floor(windowElapsed / 60000)} minutes`,
      };
    }

    return { allowed: true };
  }

  async recordMessage(leadId: number): Promise<void> {
    const lead = await this.db.getLeadById(leadId);
    if (!lead) return;

    const now = Date.now();
    const windowStart = lead.rate_limit_window_start || now;

    // Initialize window if needed
    if (!lead.rate_limit_window_start) {
      await this.db.updateRateLimitWindow(leadId, now);
    }

    // Increment count
    await this.db.updateRateLimitCount(leadId, lead.rate_limit_count + 1);
  }

  /**
   * Atomic check-and-record in a single DB transaction.
   * Returns whether the message is allowed and the current count.
   */
  async checkAndRecordAtomic(leadId: number): Promise<RateLimitResult & { count: number }> {
    if (!this.config.enabled) {
      return { allowed: true, count: 0 };
    }

    return this.db.checkAndRecordMessage(leadId, this.config.messagesPerHour, this.config.windowMs);
  }

  async clearLimit(leadId: number): Promise<void> {
    await this.db.resetRateLimit(leadId);
  }

  async isLimitExpired(leadId: number): Promise<boolean> {
    const lead = await this.db.getLeadById(leadId);
    if (!lead || !lead.rate_limit_window_start) {
      return true;
    }

    const elapsed = Date.now() - lead.rate_limit_window_start;
    return elapsed > this.config.windowMs;
  }
}
