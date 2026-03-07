import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Bollinger Bands strategy.
 * Buy when close < lower band (oversold reversion).
 * Sell when close > upper band (overbought reversion).
 */
export function createBollingerBands(params?: {
  period?: number;
  stdDev?: number;
  sizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const period = params?.period ?? 20;
  const stdDev = params?.stdDev ?? 2;
  const sizePct = params?.sizePct ?? 100;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "bollinger-bands",
    name: "Bollinger Bands",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: { period, stdDev, sizePct },
    parameterRanges: {
      period: { min: 10, max: 50, step: 5 },
      stdDev: { min: 1, max: 3, step: 0.5 },
      sizePct: { min: 10, max: 100, step: 10 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const bands = ctx.indicators.bollingerBands(period, stdDev);

      const len = bands.upper.length;
      if (len < 1) return null;

      const upper = bands.upper[len - 1]!;
      const lower = bands.lower[len - 1]!;

      if (Number.isNaN(upper) || Number.isNaN(lower)) return null;

      const close = bar.close;
      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // Close below lower band → oversold, buy
      if (close < lower && !hasLong) {
        return {
          action: "buy",
          symbol,
          sizePct,
          orderType: "market",
          reason: `BB oversold: close=${close.toFixed(2)} < lower=${lower.toFixed(2)}`,
          confidence: 0.65,
        };
      }

      // Close above upper band → overbought, sell
      if (close > upper && hasLong) {
        return {
          action: "sell",
          symbol,
          sizePct: 100,
          orderType: "market",
          reason: `BB overbought: close=${close.toFixed(2)} > upper=${upper.toFixed(2)}`,
          confidence: 0.65,
        };
      }

      return null;
    },
  };
}
