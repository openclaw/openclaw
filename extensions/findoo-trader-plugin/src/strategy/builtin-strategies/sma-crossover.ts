import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * SMA Crossover strategy.
 * Buy when SMA(fast) crosses above SMA(slow).
 * Sell when SMA(fast) crosses below SMA(slow).
 */
export function createSmaCrossover(params?: {
  fastPeriod?: number;
  slowPeriod?: number;
  sizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const fastPeriod = params?.fastPeriod ?? 10;
  const slowPeriod = params?.slowPeriod ?? 30;
  const sizePct = params?.sizePct ?? 100;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "sma-crossover",
    name: "SMA Crossover",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: { fastPeriod, slowPeriod, sizePct },
    parameterRanges: {
      fastPeriod: { min: 5, max: 50, step: 5 },
      slowPeriod: { min: 20, max: 200, step: 10 },
      sizePct: { min: 10, max: 100, step: 10 },
    },

    async onBar(_bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const fastSma = ctx.indicators.sma(fastPeriod);
      const slowSma = ctx.indicators.sma(slowPeriod);

      const len = fastSma.length;
      if (len < 2) return null;

      const currFast = fastSma[len - 1]!;
      const currSlow = slowSma[len - 1]!;
      const prevFast = fastSma[len - 2]!;
      const prevSlow = slowSma[len - 2]!;

      // Skip if any value is NaN (warm-up period)
      if (
        Number.isNaN(currFast) ||
        Number.isNaN(currSlow) ||
        Number.isNaN(prevFast) ||
        Number.isNaN(prevSlow)
      ) {
        return null;
      }

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // Golden cross: fast crosses above slow → buy
      if (prevFast <= prevSlow && currFast > currSlow && !hasLong) {
        return {
          action: "buy",
          symbol,
          sizePct,
          orderType: "market",
          reason: `SMA golden cross: fast(${fastPeriod})=${currFast.toFixed(2)} > slow(${slowPeriod})=${currSlow.toFixed(2)}`,
          confidence: 0.7,
        };
      }

      // Death cross: fast crosses below slow → sell
      if (prevFast >= prevSlow && currFast < currSlow && hasLong) {
        return {
          action: "sell",
          symbol,
          sizePct: 100,
          orderType: "market",
          reason: `SMA death cross: fast(${fastPeriod})=${currFast.toFixed(2)} < slow(${slowPeriod})=${currSlow.toFixed(2)}`,
          confidence: 0.7,
        };
      }

      return null;
    },
  };
}
