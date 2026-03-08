/**
 * Alpha Factory Orchestrator: main entry point that wires all sub-modules.
 *
 * Thin coordinator — delegates to screening, validation, evolution, and GC
 * sub-modules and tracks aggregate stats.
 */

import type { FactoryStats, ScreeningResult, ValidationResult, GCResult } from "./types.js";

interface ActivityLogLike {
  append(entry: Record<string, unknown>): void;
}

export interface AlphaFactoryDeps {
  screeningPipeline?: { screen(ids: string[]): Promise<ScreeningResult[]> };
  validationOrchestrator?: {
    validate(...args: unknown[]): Promise<ValidationResult>;
  };
  evolutionScheduler?: {
    start(): void;
    stop(): void;
    getStats(): Record<string, unknown>;
  };
  garbageCollector?: { collect(...args: unknown[]): GCResult };
  activityLog?: ActivityLogLike;
  /** Called for each strategy that fails screening or validation. */
  onFailure?: (strategyId: string, stage: string, reason: string) => void;
}

export class AlphaFactoryOrchestrator {
  private running = false;
  private stats: FactoryStats;

  constructor(private deps: AlphaFactoryDeps) {
    this.stats = {
      running: false,
      ideationCount: 0,
      screeningPassed: 0,
      screeningFailed: 0,
      validationPassed: 0,
      validationFailed: 0,
      gcKilled: 0,
      evolutionCycles: 0,
      lastCycleAt: 0,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stats.running = true;
    this.deps.evolutionScheduler?.start();
    this.deps.activityLog?.append({
      category: "factory",
      action: "orchestrator_started",
      detail: "Alpha Factory orchestrator started",
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stats.running = false;
    this.deps.evolutionScheduler?.stop();
  }

  getStats(): FactoryStats {
    return { ...this.stats };
  }

  /** Manual trigger of screening pipeline on given strategy IDs. */
  async runScreening(strategyIds: string[]): Promise<{ passed: string[]; failed: string[] }> {
    if (!this.deps.screeningPipeline) {
      return { passed: [], failed: strategyIds };
    }

    const results = await this.deps.screeningPipeline.screen(strategyIds);
    const passed = results.filter((r) => r.passed).map((r) => r.strategyId);
    const failed = results.filter((r) => !r.passed).map((r) => r.strategyId);

    this.stats.screeningPassed += passed.length;
    this.stats.screeningFailed += failed.length;
    this.stats.lastCycleAt = Date.now();

    // Notify failures
    for (const r of results.filter((r) => !r.passed)) {
      this.deps.onFailure?.(r.strategyId, "screening", r.failReason ?? "screening failed");
    }

    return { passed, failed };
  }

  /** Manual trigger of full pipeline: screen → validate. */
  async runFullPipeline(
    strategyIds: string[],
  ): Promise<{ screened: number; validated: number; failed: number }> {
    const { passed: screenPassed, failed: screenFailed } = await this.runScreening(strategyIds);

    let validated = 0;
    let validationFailed = 0;

    if (this.deps.validationOrchestrator) {
      for (const id of screenPassed) {
        try {
          const result = await this.deps.validationOrchestrator.validate(id);
          if (result.passed) {
            validated++;
            this.stats.validationPassed++;
          } else {
            validationFailed++;
            this.stats.validationFailed++;
            this.deps.onFailure?.(id, "validation", result.failedAt ?? "validation failed");
          }
        } catch {
          validationFailed++;
          this.stats.validationFailed++;
          this.deps.onFailure?.(id, "validation", "validation error");
        }
      }
    } else {
      // No validator — treat all screened as validated
      validated = screenPassed.length;
    }

    this.stats.lastCycleAt = Date.now();

    return {
      screened: screenPassed.length + screenFailed.length,
      validated,
      failed: screenFailed.length + validationFailed,
    };
  }
}
