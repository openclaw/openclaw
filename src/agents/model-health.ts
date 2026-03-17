import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("model-health");

/**
 * Circuit breaker state machine:
 * - "closed": Normal operation, calls go through
 * - "open": Too many failures, calls blocked (except probes)
 * - "half-open": Recovering after open, allows limited probes
 */
export type CircuitState = "closed" | "open" | "half-open";

export type ModelHealthEntry = {
  provider: string;
  model: string;
  windowStart: number; // timestamp of sliding window start
  successes: number;
  failures: number;
  lastFailure: number; // timestamp of last failure
  circuitTrips: number; // number of times circuit has been tripped (for backoff)
  circuitState: CircuitState;
  openUntil: number; // timestamp when circuit should transition to half-open
  halfOpenProbesRemaining: number; // number of probes allowed in half-open state
};

export type CircuitBreakerConfig = {
  enabled: boolean;
  windowMs: number; // sliding window duration (default: 5 min)
  failureThreshold: number; // open circuit at this failure rate (0-1, default: 0.7)
  minSamples: number; // minimum samples before judging (default: 5)
  openDurationMs: number; // initial open duration (default: 2 min)
  maxOpenDurationMs: number; // max open duration (default: 30 min)
  backoffMultiplier: number; // multiply open duration on repeated trips (default: 2)
  halfOpenMaxProbes: number; // probes allowed in half-open state (default: 1)
};

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  enabled: false,
  windowMs: 5 * 60_000, // 5 minutes
  failureThreshold: 0.7, // 70%
  minSamples: 5,
  openDurationMs: 2 * 60_000, // 2 minutes
  maxOpenDurationMs: 30 * 60_000, // 30 minutes
  backoffMultiplier: 2,
  halfOpenMaxProbes: 1,
};

/**
 * In-memory model health tracker with sliding window failure rates.
 * Thread-safe for readonly operations; write operations assume sequential execution.
 */
export class ModelHealthTracker {
  private healthMap = new Map<string, ModelHealthEntry>();
  private config: CircuitBreakerConfig;
  private lastSnapshotMs = 0;
  private snapshotIntervalMs = 5 * 60_000; // emit snapshot every 5 min

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Generate a unique key for provider/model pair.
   */
  private key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  /**
   * Get or create a health entry for a model.
   */
  private getOrCreateEntry(provider: string, model: string, now: number): ModelHealthEntry {
    const k = this.key(provider, model);
    let entry = this.healthMap.get(k);

    if (!entry) {
      entry = {
        provider,
        model,
        windowStart: now,
        successes: 0,
        failures: 0,
        lastFailure: 0,
        circuitTrips: 0,
        circuitState: "closed",
        openUntil: 0,
        halfOpenProbesRemaining: this.config.halfOpenMaxProbes,
      };
      this.healthMap.set(k, entry);
    }

    return entry;
  }

  /**
   * Slide the window: if window has passed its duration, reset counters and advance start.
   */
  private slideWindow(entry: ModelHealthEntry, now: number): void {
    if (now - entry.windowStart >= this.config.windowMs) {
      entry.windowStart = now;
      entry.successes = 0;
      entry.failures = 0;
    }
  }

  /**
   * Check if circuit should transition from open to half-open.
   */
  private evaluateCircuitTransition(entry: ModelHealthEntry, now: number): void {
    if (entry.circuitState === "open" && now >= entry.openUntil) {
      // Transition from open to half-open
      entry.circuitState = "half-open";
      entry.halfOpenProbesRemaining = this.config.halfOpenMaxProbes;
      log.info(`Circuit transitioned to half-open for ${entry.provider}/${entry.model}`);
    }
  }

  /**
   * Check if circuit should open based on current failure rate.
   */
  private evaluateFailureRate(entry: ModelHealthEntry, now: number): void {
    // If in half-open state and failed probe, reopen circuit
    if (entry.circuitState === "half-open") {
      const nextOpen = Math.min(
        this.config.openDurationMs * Math.pow(this.config.backoffMultiplier, entry.circuitTrips),
        this.config.maxOpenDurationMs,
      );
      entry.circuitState = "open";
      entry.openUntil = now + nextOpen;
      entry.halfOpenProbesRemaining = this.config.halfOpenMaxProbes;
      entry.circuitTrips += 1;

      log.warn(
        `Circuit reopened for ${entry.provider}/${entry.model} (failed half-open probe). Open for ${nextOpen}ms.`,
      );
      return;
    }

    if (entry.circuitState === "open") {
      return; // already open, don't re-evaluate
    }

    const total = entry.successes + entry.failures;
    if (total < this.config.minSamples) {
      return; // not enough samples yet
    }

    const failureRate = entry.failures / total;
    if (failureRate >= this.config.failureThreshold) {
      // Trip the circuit - use circuitTrips to calculate exponential backoff
      const nextOpen = Math.min(
        this.config.openDurationMs * Math.pow(this.config.backoffMultiplier, entry.circuitTrips),
        this.config.maxOpenDurationMs,
      );
      entry.circuitState = "open";
      entry.openUntil = now + nextOpen;
      entry.halfOpenProbesRemaining = this.config.halfOpenMaxProbes;
      entry.circuitTrips += 1;

      log.warn(
        `Circuit opened for ${entry.provider}/${entry.model}: ${(failureRate * 100).toFixed(1)}% failure rate (${entry.failures}/${total}). Open for ${nextOpen}ms.`,
      );
    }
  }

  /**
   * Record a success or failure for a model call.
   */
  public record(provider: string, model: string, success: boolean): void {
    if (!this.config.enabled) {
      return;
    }

    const now = Date.now();
    const entry = this.getOrCreateEntry(provider, model, now);

    this.slideWindow(entry, now);

    if (success) {
      entry.successes += 1;

      // In half-open state, successful calls allow full recovery
      if (entry.circuitState === "half-open") {
        entry.circuitState = "closed";
        entry.successes = 0;
        entry.failures = 0;
        log.info(`Circuit recovered for ${entry.provider}/${entry.model} (successful probe)`);
      }
    } else {
      entry.failures += 1;
      entry.lastFailure = now;

      this.evaluateFailureRate(entry, now);
    }

    // Emit periodic snapshots for monitoring
    if (now - this.lastSnapshotMs >= this.snapshotIntervalMs) {
      this.emitSnapshot();
      this.lastSnapshotMs = now;
    }
  }

  /**
   * Check if a model can be attempted.
   * Returns: true if closed or half-open with probes remaining; false if open.
   */
  public canAttempt(provider: string, model: string): boolean {
    if (!this.config.enabled) {
      return true;
    }

    const now = Date.now();
    const entry = this.getOrCreateEntry(provider, model, now);

    // Check if circuit should transition from open to half-open
    this.evaluateCircuitTransition(entry, now);

    switch (entry.circuitState) {
      case "closed":
        return true;
      case "half-open":
        if (entry.halfOpenProbesRemaining > 0) {
          entry.halfOpenProbesRemaining -= 1;
          return true;
        }
        return false;
      case "open":
        return false;
    }
  }

  /**
   * Get current health status for a model.
   */
  public getHealth(provider: string, model: string) {
    const entry = this.healthMap.get(this.key(provider, model));
    if (!entry) {
      return null;
    }

    const total = entry.successes + entry.failures;
    return {
      provider: entry.provider,
      model: entry.model,
      state: entry.circuitState,
      failureRate: total > 0 ? entry.failures / total : 0,
      successes: entry.successes,
      failures: entry.failures,
      circuitTrips: entry.circuitTrips,
      lastFailure: entry.lastFailure,
    };
  }

  /**
   * Get all current health entries (for testing and snapshots).
   */
  public getAllHealth() {
    const results = [];
    for (const entry of this.healthMap.values()) {
      const total = entry.successes + entry.failures;
      results.push({
        provider: entry.provider,
        model: entry.model,
        state: entry.circuitState,
        failureRate: total > 0 ? entry.failures / total : 0,
        successes: entry.successes,
        failures: entry.failures,
        circuitTrips: entry.circuitTrips,
        lastFailure: entry.lastFailure,
      });
    }
    return results;
  }

  /**
   * Emit a health snapshot for monitoring.
   */
  private emitSnapshot(): void {
    const health = this.getAllHealth();
    const openCircuits = health.filter((h) => h.state === "open");

    if (openCircuits.length > 0 || health.some((h) => h.failureRate > 0.5)) {
      log.info("model health snapshot", {
        event: "model_health_snapshot",
        timestamp: new Date().toISOString(),
        models: health.map((h) => ({
          model: `${h.provider}/${h.model}`,
          state: h.state,
          failureRate: (h.failureRate * 100).toFixed(1) + "%",
          successes: h.successes,
          failures: h.failures,
          circuitTrips: h.circuitTrips,
        })),
      });
    }
  }

  /**
   * Get current config.
   */
  public getConfig(): Readonly<CircuitBreakerConfig> {
    return { ...this.config };
  }

  /**
   * Update config (mainly for testing).
   */
  public updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reset all state (mainly for testing).
   */
  public reset(): void {
    this.healthMap.clear();
    this.lastSnapshotMs = 0;
  }
}

/**
 * Global singleton instance.
 */
let globalInstance: ModelHealthTracker | null = null;

/**
 * Get the global model health tracker instance.
 * Create with default config if not yet initialized.
 */
export function getModelHealthTracker(config?: Partial<CircuitBreakerConfig>): ModelHealthTracker {
  if (!globalInstance) {
    globalInstance = new ModelHealthTracker(config);
  }
  return globalInstance;
}

/**
 * Reset the global instance (mainly for testing).
 */
export function resetModelHealthTracker(): void {
  globalInstance = null;
}
