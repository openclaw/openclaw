import type { Allocation, StrategyProfile, FundConfig } from "./types.js";

/**
 * Modified Half-Kelly capital allocator.
 *
 * Constraints:
 * - Single strategy ≤ maxSingleStrategyPct (default 30%)
 * - Total exposure ≤ maxTotalExposurePct (default 70%)
 * - High-correlation group ≤ 40%
 * - New L3 strategies (< 30 days) start at ≤ 10%
 * - Allocations proportional to fitness rank
 */
export class CapitalAllocator {
  /**
   * Compute allocations for active strategies.
   *
   * @param strategies - Eligible strategies (L2+ with positive fitness)
   * @param totalCapital - Total fund capital
   * @param config - Fund constraints
   * @param correlations - Optional correlation matrix (strategy pairs)
   */
  allocate(
    strategies: StrategyProfile[],
    totalCapital: number,
    config: FundConfig,
    correlations?: Map<string, Map<string, number>>,
  ): Allocation[] {
    if (strategies.length === 0 || totalCapital <= 0) return [];

    // Only allocate to strategies with positive fitness
    const eligible = strategies
      .filter((s) => s.fitness > 0 && (s.level === "L2_PAPER" || s.level === "L3_LIVE"))
      .sort((a, b) => b.fitness - a.fitness);

    if (eligible.length === 0) return [];

    // Max allocatable = totalCapital * maxTotalExposure
    const maxExposure = totalCapital * (config.maxTotalExposurePct / 100);
    const maxSingle = totalCapital * (config.maxSingleStrategyPct / 100);

    // Half-Kelly weights: proportional to fitness, halved for safety
    const totalFitness = eligible.reduce((sum, s) => sum + s.fitness, 0);
    const rawWeights = eligible.map((s) => ({
      strategy: s,
      rawWeight: (s.fitness / totalFitness) * 0.5, // Half-Kelly
    }));

    // Apply per-strategy constraints
    const constrained = rawWeights.map(({ strategy, rawWeight }) => {
      let weight = rawWeight;

      // Cap: single strategy ≤ maxSingleStrategyPct
      const singleCap = config.maxSingleStrategyPct / 100;
      weight = Math.min(weight, singleCap);

      // New L3 strategies: cap at 10% for first 30 days
      if (strategy.level === "L3_LIVE" && (strategy.paperDaysActive ?? 0) < 30) {
        weight = Math.min(weight, 0.1);
      }

      // L2 paper strategies get smaller allocation than L3
      if (strategy.level === "L2_PAPER") {
        weight = Math.min(weight, 0.15); // Max 15% for paper strategies
      }

      return { strategy, weight };
    });

    // Apply correlation constraints if available
    if (correlations) {
      applyCorrelationConstraints(constrained, correlations);
    }

    // Normalize to fit within maxExposure
    const totalWeight = constrained.reduce((sum, c) => sum + c.weight, 0);
    const maxWeightRatio = config.maxTotalExposurePct / 100;
    const scaleFactor = totalWeight > maxWeightRatio ? maxWeightRatio / totalWeight : 1;

    return constrained.map(({ strategy, weight }) => {
      const adjustedWeight = weight * scaleFactor;
      const capital = Math.min(adjustedWeight * totalCapital, maxSingle);

      return {
        strategyId: strategy.id,
        capitalUsd: Math.round(capital * 100) / 100,
        weightPct: Math.round(adjustedWeight * 10000) / 100,
        reason: buildReason(strategy, adjustedWeight),
      };
    });
  }
}

/** Reduce weight of highly correlated strategy groups to ≤ 40%. */
function applyCorrelationConstraints(
  entries: Array<{ strategy: StrategyProfile; weight: number }>,
  correlations: Map<string, Map<string, number>>,
): void {
  const HIGH_CORR = 0.7;
  const GROUP_CAP = 0.4;

  // Build correlation groups via union-find
  const groups = new Map<string, string>(); // strategyId → groupRoot
  for (const { strategy } of entries) {
    groups.set(strategy.id, strategy.id);
  }

  const find = (id: string): string => {
    let root = id;
    while (groups.get(root) !== root) {
      root = groups.get(root)!;
    }
    groups.set(id, root);
    return root;
  };

  for (const { strategy: a } of entries) {
    const row = correlations.get(a.id);
    if (!row) continue;
    for (const { strategy: b } of entries) {
      if (a.id === b.id) continue;
      const corr = row.get(b.id) ?? 0;
      if (Math.abs(corr) >= HIGH_CORR) {
        const rootA = find(a.id);
        const rootB = find(b.id);
        if (rootA !== rootB) groups.set(rootA, rootB);
      }
    }
  }

  // Sum weight per group and scale down if exceeding cap
  const groupWeights = new Map<string, number>();
  for (const { strategy, weight } of entries) {
    const root = find(strategy.id);
    groupWeights.set(root, (groupWeights.get(root) ?? 0) + weight);
  }

  for (const { strategy } of entries) {
    const root = find(strategy.id);
    const groupTotal = groupWeights.get(root) ?? 0;
    if (groupTotal > GROUP_CAP) {
      const entry = entries.find((e) => e.strategy.id === strategy.id);
      if (entry) {
        entry.weight *= GROUP_CAP / groupTotal;
      }
    }
  }
}

function buildReason(s: StrategyProfile, weight: number): string {
  const parts: string[] = [];
  parts.push(`fitness=${s.fitness.toFixed(3)}`);
  parts.push(`level=${s.level}`);
  parts.push(`weight=${(weight * 100).toFixed(1)}%`);
  if (s.backtest) parts.push(`sharpe=${s.backtest.sharpe.toFixed(2)}`);
  return parts.join(", ");
}
