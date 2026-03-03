import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * RSI Mean Reversion strategy.
 * Buy when RSI drops below oversold threshold.
 * Sell when RSI rises above overbought threshold.
 */
export function createRsiMeanReversion(params?: {
  period?: number;
  oversold?: number;
  overbought?: number;
  sizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const period = params?.period ?? 14;
  const oversold = params?.oversold ?? 30;
  const overbought = params?.overbought ?? 70;
  const sizePct = params?.sizePct ?? 100;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "rsi-mean-reversion",
    name: "RSI Mean Reversion",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: { period, oversold, overbought, sizePct },
    parameterRanges: {
      period: { min: 7, max: 28, step: 7 },
      oversold: { min: 20, max: 40, step: 5 },
      overbought: { min: 60, max: 80, step: 5 },
      sizePct: { min: 10, max: 100, step: 10 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const rsiValues = ctx.indicators.rsi(period);
      const len = rsiValues.length;
      if (len < 1) return null;

      const currentRsi = rsiValues[len - 1]!;
      if (Number.isNaN(currentRsi)) return null;

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // RSI below oversold → buy
      if (currentRsi < oversold && !hasLong) {
        return {
          action: "buy",
          symbol,
          sizePct,
          orderType: "market",
          reason: `RSI oversold: ${currentRsi.toFixed(1)} < ${oversold}`,
          confidence: 0.6,
        };
      }

      // RSI above overbought → sell
      if (currentRsi > overbought && hasLong) {
        return {
          action: "sell",
          symbol,
          sizePct: 100,
          orderType: "market",
          reason: `RSI overbought: ${currentRsi.toFixed(1)} > ${overbought}`,
          confidence: 0.6,
        };
      }

      return null;
    },
  };
}
