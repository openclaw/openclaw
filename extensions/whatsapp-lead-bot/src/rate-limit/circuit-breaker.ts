/**
 * Circuit breaker - emergency stop when rate-limit hit rate exceeds threshold.
 * Trips at configurable hit-rate (default 80%) over a sliding window (default 5min).
 * Sends WhatsApp notifications to agents on trip/reset.
 */

import type { CircuitBreakerStore } from "../database.js";

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Hit-rate threshold (0-1) at which the breaker trips. Default 0.8 (80%). */
  hitRateThreshold: number;
  /** Window in ms over which hit-rate is measured. Default 300000 (5min). */
  windowMs: number;
  /** Minimum checks before the breaker can trip (avoids false positives on low volume). */
  minChecks: number;
}

export interface CircuitBreakerNotifier {
  notifyCircuitTripped(reason: string): Promise<void>;
  notifyCircuitReset(): Promise<void>;
}

export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
}

export class CircuitBreaker {
  constructor(
    private db: CircuitBreakerStore,
    private config: CircuitBreakerConfig,
    private notifier: CircuitBreakerNotifier,
  ) {}

  /** Check if the circuit is tripped. If tripped, deny immediately. */
  async check(): Promise<CircuitBreakerResult> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const state = await this.db.getCircuitBreaker();

    if (state.is_tripped) {
      return {
        allowed: false,
        reason: `Circuit breaker tripped: ${state.trip_reason}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record the result of a rate-limit check.
   * If hit-rate exceeds threshold over the window, trip the breaker.
   */
  async recordCheck(wasRateLimited: boolean): Promise<void> {
    if (!this.config.enabled) return;

    const state = await this.db.getCircuitBreaker();
    if (state.is_tripped) return;

    const now = Date.now();
    const elapsed = now - state.window_start;

    // Window expired → reset counters
    if (elapsed > this.config.windowMs) {
      await this.db.resetCircuitWindow(now);
      // Still record this check in the fresh window
      await this.db.recordCircuitCheck(wasRateLimited);
      return;
    }

    const updated = await this.db.recordCircuitCheck(wasRateLimited);

    // Only evaluate after minimum checks
    if (updated.total_checks < this.config.minChecks) return;

    const hitRate = updated.total_hits / updated.total_checks;
    if (hitRate >= this.config.hitRateThreshold) {
      const reason = `${Math.round(hitRate * 100)}% hit rate over ${updated.total_checks} checks in ${Math.floor(elapsed / 1000)}s`;
      await this.db.tripCircuitBreaker(reason);
      console.error(`[circuit-breaker] TRIPPED: ${reason}`);
      await this.notifier.notifyCircuitTripped(reason);
    }
  }

  /** Admin-initiated reset of the circuit breaker. */
  async reset(): Promise<void> {
    await this.db.resetCircuitBreaker();
    console.log("[circuit-breaker] Reset by admin");
    await this.notifier.notifyCircuitReset();
  }

  async getStatus(): Promise<{
    isTripped: boolean;
    trippedAt: number | null;
    reason: string | null;
    hitRate: number;
    totalChecks: number;
    totalHits: number;
  }> {
    const state = await this.db.getCircuitBreaker();
    const hitRate = state.total_checks > 0 ? state.total_hits / state.total_checks : 0;
    return {
      isTripped: state.is_tripped === 1,
      trippedAt: state.tripped_at,
      reason: state.trip_reason,
      hitRate,
      totalChecks: state.total_checks,
      totalHits: state.total_hits,
    };
  }
}
