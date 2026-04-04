/**
 * Rate limit coordinator - orchestrates 3-layer defense:
 *   1. Circuit breaker (emergency stop)
 *   2. Global limit (system-wide)
 *   3. Per-lead limit (atomic)
 *
 * Each layer is checked in order. If any denies, we short-circuit.
 * After a successful pass, we record the check in the circuit breaker.
 */

import type { CircuitBreaker } from "./circuit-breaker.js";
import type { GlobalRateLimiter } from "./global-limiter.js";
import type { RateLimiter } from "./limiter.js";

export interface CoordinatorResult {
  allowed: boolean;
  layer?: "circuit_breaker" | "global" | "per_lead";
  reason?: string;
}

export class RateLimitCoordinator {
  constructor(
    private circuitBreaker: CircuitBreaker,
    private globalLimiter: GlobalRateLimiter,
    private perLeadLimiter: RateLimiter,
  ) {}

  /**
   * Run all three layers in order. Returns on first denial.
   * On allow, records the message in global + per-lead counters,
   * and records a non-hit in the circuit breaker.
   */
  async checkAndRecord(leadId: number): Promise<CoordinatorResult> {
    // Layer 1: Circuit breaker
    const cbResult = await this.circuitBreaker.check();
    if (!cbResult.allowed) {
      return { allowed: false, layer: "circuit_breaker", reason: cbResult.reason };
    }

    // Layer 2: Global limit
    const globalResult = await this.globalLimiter.check();
    if (!globalResult.allowed) {
      await this.circuitBreaker.recordCheck(true);
      return { allowed: false, layer: "global", reason: globalResult.reason };
    }

    // Layer 3: Per-lead atomic check-and-record
    const perLeadResult = await this.perLeadLimiter.checkAndRecordAtomic(leadId);
    if (!perLeadResult.allowed) {
      await this.circuitBreaker.recordCheck(true);
      return { allowed: false, layer: "per_lead", reason: perLeadResult.reason };
    }

    // All layers passed — record in global counter + circuit breaker
    await this.globalLimiter.record();
    await this.circuitBreaker.recordCheck(false);

    return { allowed: true };
  }
}
