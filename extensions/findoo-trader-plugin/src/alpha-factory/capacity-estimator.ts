/**
 * Capacity Estimator: estimates maximum deployable capital for a strategy.
 *
 * Uses trade history and optional volume data to compute how much capital
 * a strategy can handle before market impact becomes significant.
 */

import type { TradeRecord } from "../shared/types.js";
import type { CapacityEstimate } from "./types.js";

interface DataProviderLike {
  getVolume?(symbol: string, market: string): Promise<number | null>;
}

const DEFAULT_PARTICIPATION_RATE = 0.01; // 1% of daily volume

export class CapacityEstimator {
  constructor(private deps: { dataProvider?: DataProviderLike } = {}) {}

  async estimate(
    trades: TradeRecord[],
    symbol: string,
    market = "crypto",
  ): Promise<CapacityEstimate> {
    if (trades.length === 0) {
      return {
        maxCapitalUsd: 0,
        impactCostBps: 0,
        avgDailyVolume: 0,
        participationRate: DEFAULT_PARTICIPATION_RATE,
      };
    }

    // Try to get volume from data provider
    let avgDailyVolume: number | null = null;
    if (this.deps.dataProvider?.getVolume) {
      avgDailyVolume = await this.deps.dataProvider.getVolume(symbol, market);
    }

    // Fallback: estimate from trade history
    if (!avgDailyVolume || avgDailyVolume <= 0) {
      avgDailyVolume = this.estimateVolumeFromTrades(trades);
    }

    const maxCapitalUsd = avgDailyVolume * DEFAULT_PARTICIPATION_RATE;
    const impactCostBps = DEFAULT_PARTICIPATION_RATE * 100; // Simple linear model

    return {
      maxCapitalUsd,
      impactCostBps,
      avgDailyVolume,
      participationRate: DEFAULT_PARTICIPATION_RATE,
    };
  }

  private estimateVolumeFromTrades(trades: TradeRecord[]): number {
    const totalVolume = trades.reduce((sum, t) => sum + t.quantity * t.entryPrice, 0);
    const firstTime = Math.min(...trades.map((t) => t.entryTime));
    const lastTime = Math.max(...trades.map((t) => t.exitTime));
    const tradingDays = Math.max(1, (lastTime - firstTime) / 86_400_000);
    // Assume our trades represent ~1% of market volume
    return totalVolume / tradingDays / DEFAULT_PARTICIPATION_RATE;
  }
}
