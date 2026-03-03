import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * MACD Divergence strategy.
 * Buy when MACD histogram crosses from negative to positive.
 * Sell when MACD histogram crosses from positive to negative.
 */
export function createMacdDivergence(params?: {
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  sizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const fastPeriod = params?.fastPeriod ?? 12;
  const slowPeriod = params?.slowPeriod ?? 26;
  const signalPeriod = params?.signalPeriod ?? 9;
  const sizePct = params?.sizePct ?? 100;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "macd-divergence",
    name: "MACD Divergence",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: { fastPeriod, slowPeriod, signalPeriod, sizePct },
    parameterRanges: {
      fastPeriod: { min: 8, max: 20, step: 2 },
      slowPeriod: { min: 20, max: 40, step: 2 },
      signalPeriod: { min: 5, max: 15, step: 2 },
      sizePct: { min: 10, max: 100, step: 10 },
    },

    async onBar(_bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const { histogram } = ctx.indicators.macd(fastPeriod, slowPeriod, signalPeriod);

      const len = histogram.length;
      if (len < 2) return null;

      const curr = histogram[len - 1]!;
      const prev = histogram[len - 2]!;

      if (Number.isNaN(curr) || Number.isNaN(prev)) return null;

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // Histogram crosses from negative to positive → bullish, buy
      if (prev < 0 && curr >= 0 && !hasLong) {
        return {
          action: "buy",
          symbol,
          sizePct,
          orderType: "market",
          reason: `MACD bullish cross: histogram ${prev.toFixed(4)} → ${curr.toFixed(4)}`,
          confidence: 0.6,
        };
      }

      // Histogram crosses from positive to negative → bearish, sell
      if (prev >= 0 && curr < 0 && hasLong) {
        return {
          action: "sell",
          symbol,
          sizePct: 100,
          orderType: "market",
          reason: `MACD bearish cross: histogram ${prev.toFixed(4)} → ${curr.toFixed(4)}`,
          confidence: 0.6,
        };
      }

      return null;
    },
  };
}
