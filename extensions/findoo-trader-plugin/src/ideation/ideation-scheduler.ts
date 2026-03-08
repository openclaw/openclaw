/**
 * IdeationScheduler — periodic orchestrator that runs the full ideation cycle:
 * MarketScanner → DeduplicationFilter → IdeationEngine → LLM wake.
 *
 * Follows the DailyBriefScheduler timer pattern: start/stop/getStats/getLastResult.
 */

import type { ActivityLogStore } from "../core/activity-log-store.js";
import type { DeduplicationFilter } from "./dedup-filter.js";
import type { IdeationEngine } from "./ideation-engine.js";
import type { MarketScanner } from "./market-scanner.js";
import type { IdeationConfig, IdeationResult } from "./types.js";
import { DEFAULT_IDEATION_CONFIG } from "./types.js";

export interface IdeationSchedulerDeps {
  scanner: MarketScanner;
  engine: IdeationEngine;
  filter: DeduplicationFilter;
  activityLog?: ActivityLogStore;
  /** Returns names of existing strategies for dedup prompt context. */
  existingStrategyNamesResolver: () => string[];
  /** Returns current max concurrent strategy count. */
  maxConcurrentResolver?: () => number;
  /** Returns failure feedback summary for ideation prompt injection. */
  failureFeedbackResolver?: () => string;
}

export class IdeationScheduler {
  private deps: IdeationSchedulerDeps;
  private config: IdeationConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;
  private lastCycleAt: number | null = null;
  private lastResult: IdeationResult | null = null;

  constructor(deps: IdeationSchedulerDeps, config?: Partial<IdeationConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_IDEATION_CONFIG, ...config };
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.timer = setInterval(() => void this.runCycle(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): {
    running: boolean;
    cycleCount: number;
    lastCycleAt: number | null;
    enabled: boolean;
    intervalMs: number;
  } {
    return {
      running: this.timer !== null,
      cycleCount: this.cycleCount,
      lastCycleAt: this.lastCycleAt,
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
    };
  }

  getLastResult(): IdeationResult | null {
    return this.lastResult;
  }

  getConfig(): IdeationConfig {
    return { ...this.config };
  }

  /** Run a single ideation cycle: scan → filter → wake LLM. */
  async runCycle(): Promise<IdeationResult> {
    const startMs = Date.now();

    this.deps.activityLog?.append({
      category: "ideation",
      action: "cycle_start",
      detail: `Ideation cycle #${this.cycleCount + 1} starting`,
    });

    // Check max concurrent strategies limit
    const maxConcurrent = this.deps.maxConcurrentResolver?.() ?? 20;
    const existingNames = this.deps.existingStrategyNamesResolver();
    if (existingNames.length >= maxConcurrent) {
      const result: IdeationResult = {
        timestamp: startMs,
        snapshot: {
          timestamp: startMs,
          symbols: [],
          regimeSummary: {},
          crossMarket: { cryptoBullishPct: 0, equityBullishPct: 0, highVolatilitySymbols: [] },
        },
        created: [],
        skippedDuplicates: [],
      };
      this.deps.activityLog?.append({
        category: "ideation",
        action: "cycle_skip",
        detail: `Skipped: ${existingNames.length} strategies >= max ${maxConcurrent}`,
      });
      this.lastResult = result;
      this.lastCycleAt = startMs;
      this.cycleCount++;
      return result;
    }

    // 1. Scan markets
    const snapshot = await this.deps.scanner.scan(this.config);

    if (snapshot.symbols.length === 0) {
      const result: IdeationResult = {
        timestamp: startMs,
        snapshot,
        created: [],
        skippedDuplicates: [],
      };
      this.deps.activityLog?.append({
        category: "ideation",
        action: "cycle_empty",
        detail: "No market data collected — data provider may be unavailable",
      });
      this.lastResult = result;
      this.lastCycleAt = startMs;
      this.cycleCount++;
      return result;
    }

    // 2. Trigger ideation (LLM wake)
    // The LLM agent will call fin_strategy_create which goes through the
    // normal StrategyRegistry path. Dedup happens at prompt level (existing
    // strategy names are listed) and the LLM is instructed not to duplicate.
    const failurePatterns = this.deps.failureFeedbackResolver?.() ?? "";
    this.deps.engine.triggerIdeation(
      snapshot,
      existingNames,
      this.config.maxStrategiesPerCycle,
      failurePatterns || undefined,
    );

    const result: IdeationResult = {
      timestamp: startMs,
      snapshot,
      created: [], // LLM creates strategies asynchronously via tools
      skippedDuplicates: [],
    };

    const elapsed = Date.now() - startMs;
    this.deps.activityLog?.append({
      category: "ideation",
      action: "cycle_complete",
      detail: `Cycle #${this.cycleCount + 1} complete: ${snapshot.symbols.length} symbols scanned in ${elapsed}ms. LLM wakened for analysis.`,
      metadata: {
        symbolCount: snapshot.symbols.length,
        elapsedMs: elapsed,
        crossMarket: snapshot.crossMarket,
      },
    });

    this.lastResult = result;
    this.lastCycleAt = Date.now();
    this.cycleCount++;
    return result;
  }
}
