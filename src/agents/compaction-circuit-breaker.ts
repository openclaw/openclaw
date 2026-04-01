import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("compaction");

export type CircuitBreakerConfig = {
  /** Max consecutive failures before opening the circuit. Default: 3. */
  maxFailures?: number;
  /** Time in ms before attempting again after circuit opens. Default: 60_000 (1 min). */
  resetAfterMs?: number;
};

export type CircuitState = "closed" | "open" | "half-open";

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_RESET_AFTER_MS = 60_000;

/**
 * Circuit breaker for compaction retry loops.
 *
 * When compaction fails repeatedly (model errors, timeouts, malformed output),
 * the retry logic can burn tokens without progress. The circuit breaker stops
 * attempts after N consecutive failures, resuming only after a cooldown period.
 *
 * States:
 *   closed    → normal operation, compaction allowed
 *   open      → blocked after N failures, compaction skipped
 *   half-open → cooldown expired, one attempt allowed to test recovery
 */
export class CompactionCircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly maxFailures: number;
  private readonly resetAfterMs: number;

  constructor(config?: CircuitBreakerConfig) {
    this.maxFailures = Math.max(1, config?.maxFailures ?? DEFAULT_MAX_FAILURES);
    this.resetAfterMs = Math.max(1000, config?.resetAfterMs ?? DEFAULT_RESET_AFTER_MS);
  }

  get state(): CircuitState {
    if (this.consecutiveFailures < this.maxFailures) {
      return "closed";
    }
    const elapsed = Date.now() - this.lastFailureTime;
    if (elapsed >= this.resetAfterMs) {
      return "half-open";
    }
    return "open";
  }

  /**
   * Check if a compaction attempt is allowed.
   * Returns true in closed and half-open states, false when open.
   */
  canAttempt(): boolean {
    const currentState = this.state;
    if (currentState === "open") {
      log.debug(
        `Compaction circuit breaker OPEN — ${this.consecutiveFailures} consecutive failures, ` +
          `cooldown ${Math.ceil((this.resetAfterMs - (Date.now() - this.lastFailureTime)) / 1000)}s remaining`,
      );
      return false;
    }
    if (currentState === "half-open") {
      log.debug("Compaction circuit breaker HALF-OPEN — allowing one test attempt");
    }
    return true;
  }

  /** Record a successful compaction. Resets the circuit to closed. */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.debug(
        `Compaction circuit breaker reset after ${this.consecutiveFailures} consecutive failures`,
      );
    }
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }

  /** Record a failed compaction. May open the circuit. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.maxFailures) {
      log.warn(
        `Compaction circuit breaker OPENED after ${this.consecutiveFailures} consecutive failures — ` +
          `pausing compaction for ${Math.ceil(this.resetAfterMs / 1000)}s`,
      );
    }
  }

  /** Reset the circuit breaker to initial state. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}
