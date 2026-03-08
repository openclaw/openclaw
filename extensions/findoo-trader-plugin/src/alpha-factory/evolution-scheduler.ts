/**
 * Evolution Scheduler: periodically checks strategies for alpha decay
 * and triggers evolution cycles on decaying strategies.
 *
 * Follows the LifecycleEngine timer pattern (start/stop/getStats + setInterval).
 */

import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import { estimateAlphaDecay } from "./alpha-decay-estimator.js";
import type { DecayEstimate } from "./types.js";

interface StrategyRegistryLike {
  list(filter?: { level?: string }): Array<{
    id: string;
    name: string;
    level: string;
  }>;
}

interface EvolutionEngineLike {
  runRdavdCycle?(strategyId: string): Promise<{ evolved: boolean; reason: string }>;
}

interface ActivityLogLike {
  append(entry: Record<string, unknown>): void;
}

interface PaperEngineLike {
  getSnapshots?(id: string): Array<{
    timestamp: number;
    equity: number;
    dailyPnl: number;
    dailyPnlPct: number;
  }> | null;
}

export interface EvolutionSchedulerDeps {
  strategyRegistry: StrategyRegistryLike;
  evolutionEngineResolver: () => EvolutionEngineLike | undefined;
  paperEngine?: PaperEngineLike;
  activityLog?: ActivityLogLike;
  wakeBridge?: AgentWakeBridge;
}

export class EvolutionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;
  private lastCycleAt = 0;
  private evolvedCount = 0;
  private skippedCount = 0;

  constructor(
    private deps: EvolutionSchedulerDeps,
    private intervalMs = 86_400_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
    this.deps.activityLog?.append({
      category: "heartbeat",
      action: "evolution_scheduler_started",
      detail: `Evolution scheduler started (interval=${Math.round(this.intervalMs / 1000)}s)`,
    });
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
    lastCycleAt: number;
    evolvedCount: number;
    skippedCount: number;
  } {
    return {
      running: this.timer !== null,
      cycleCount: this.cycleCount,
      lastCycleAt: this.lastCycleAt,
      evolvedCount: this.evolvedCount,
      skippedCount: this.skippedCount,
    };
  }

  async runCycle(): Promise<{ evolved: number; skipped: number }> {
    const engine = this.deps.evolutionEngineResolver();
    let evolved = 0;
    let skipped = 0;

    if (!engine?.runRdavdCycle) {
      this.cycleCount++;
      this.lastCycleAt = Date.now();
      return { evolved, skipped };
    }

    // Check L2_PAPER and L3_LIVE strategies
    const strategies = [
      ...this.deps.strategyRegistry.list({ level: "L2_PAPER" }),
      ...this.deps.strategyRegistry.list({ level: "L3_LIVE" }),
    ];

    for (const strat of strategies) {
      try {
        const decay = this.computeDecay(strat.id);
        if (!decay || decay.classification === "stable") {
          skipped++;
          continue;
        }

        // Decaying strategy — notify Agent instead of auto-executing
        if (this.deps.wakeBridge) {
          this.deps.wakeBridge.onEvolutionNeeded({
            strategyId: strat.id,
            name: strat.name,
            classification: decay.classification,
            halfLifeDays: decay.halfLifeDays,
          });
          evolved++; // counted as "actioned" (wake sent)
        } else {
          // Fallback: direct execution if no wakeBridge (backward compat)
          const result = await engine.runRdavdCycle(strat.id);
          if (result.evolved) {
            evolved++;
            this.deps.activityLog?.append({
              category: "evolution",
              action: "strategy_evolved",
              strategyId: strat.id,
              detail: `Evolved "${strat.name}": ${result.reason} (decay=${decay.classification}, halfLife=${decay.halfLifeDays.toFixed(1)}d)`,
            });
          } else {
            skipped++;
          }
        }
      } catch {
        skipped++;
      }
    }

    this.evolvedCount += evolved;
    this.skippedCount += skipped;
    this.cycleCount++;
    this.lastCycleAt = Date.now();

    return { evolved, skipped };
  }

  private computeDecay(strategyId: string): DecayEstimate | null {
    const snapshots = this.deps.paperEngine?.getSnapshots?.(strategyId);
    if (!snapshots || snapshots.length < 10) return null;

    // Compute rolling 7-day Sharpes from daily returns
    const returns = snapshots.map((s) => s.dailyPnlPct);
    const windowSize = 7;
    const rollingSharpes: number[] = [];

    for (let i = windowSize; i <= returns.length; i++) {
      const window = returns.slice(i - windowSize, i);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
      const std = Math.sqrt(variance);
      if (std > 0) {
        rollingSharpes.push((mean / std) * Math.sqrt(252));
      }
    }

    if (rollingSharpes.length < 5) return null;
    return estimateAlphaDecay(rollingSharpes);
  }
}
