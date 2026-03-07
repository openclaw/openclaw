import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Volatility Mean Reversion strategy.
 * Enters long when price drops below Bollinger Band lower with RSI oversold confirmation
 * and RSI turning up. Exits when price reverts to BB middle, RSI becomes overbought,
 * or a time stop (10 bars) is triggered.
 */
export function createVolatilityMeanReversion(params?: {
  bbPeriod?: number;
  bbStdDev?: number;
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  atrPeriod?: number;
  atrStopMultiplier?: number;
  trendFilterPeriod?: number;
  useTrendFilter?: number;
  maxSizePct?: number;
  maxAtrPctFilter?: number;
  symbol?: string;
}): StrategyDefinition {
  const bbPeriod = params?.bbPeriod ?? 20;
  const bbStdDev = params?.bbStdDev ?? 2.0;
  const rsiPeriod = params?.rsiPeriod ?? 7;
  const rsiOversold = params?.rsiOversold ?? 25;
  const rsiOverbought = params?.rsiOverbought ?? 75;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrStopMultiplier = params?.atrStopMultiplier ?? 1.5;
  const trendFilterPeriod = params?.trendFilterPeriod ?? 200;
  const useTrendFilter = params?.useTrendFilter ?? 1;
  const maxSizePct = params?.maxSizePct ?? 60;
  const maxAtrPctFilter = params?.maxAtrPctFilter ?? 5.0;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "volatility-mean-reversion",
    name: "Volatility Mean Reversion",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {
      bbPeriod,
      bbStdDev,
      rsiPeriod,
      rsiOversold,
      rsiOverbought,
      atrPeriod,
      atrStopMultiplier,
      trendFilterPeriod,
      useTrendFilter,
      maxSizePct,
      maxAtrPctFilter,
    },
    parameterRanges: {
      bbPeriod: { min: 10, max: 50, step: 5 },
      bbStdDev: { min: 1.0, max: 3.0, step: 0.25 },
      rsiPeriod: { min: 3, max: 21, step: 2 },
      rsiOversold: { min: 15, max: 35, step: 5 },
      rsiOverbought: { min: 65, max: 85, step: 5 },
      atrPeriod: { min: 7, max: 28, step: 7 },
      atrStopMultiplier: { min: 1.0, max: 3.0, step: 0.5 },
      trendFilterPeriod: { min: 50, max: 200, step: 50 },
      useTrendFilter: { min: 0, max: 1, step: 1 },
      maxSizePct: { min: 20, max: 100, step: 10 },
      maxAtrPctFilter: { min: 2.0, max: 10.0, step: 1.0 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      const bb = ctx.indicators.bollingerBands(bbPeriod, bbStdDev);
      const rsiValues = ctx.indicators.rsi(rsiPeriod);
      const atrValues = ctx.indicators.atr(atrPeriod);
      const sma200 = ctx.indicators.sma(trendFilterPeriod);

      const len = rsiValues.length;
      if (len < 2) return null;

      const currRsi = rsiValues[len - 1]!;
      const prevRsi = rsiValues[len - 2]!;
      const upper = bb.upper[len - 1]!;
      const lower = bb.lower[len - 1]!;
      const middle = bb.middle[len - 1]!;
      const currAtr = atrValues[len - 1]!;
      const currSma200 = sma200[len - 1]!;

      // NaN check on current values
      if (
        Number.isNaN(currRsi) ||
        Number.isNaN(prevRsi) ||
        Number.isNaN(upper) ||
        Number.isNaN(lower) ||
        Number.isNaN(middle) ||
        Number.isNaN(currAtr)
      ) {
        return null;
      }

      // Trend filter NaN check (only when enabled)
      if (useTrendFilter && Number.isNaN(currSma200)) {
        return null;
      }

      // Regime filter: skip during crisis
      if (ctx.regime === "crisis") {
        return null;
      }

      // Compute %B = (close - lower) / (upper - lower)
      const bbWidth = upper - lower;
      const percentB = bbWidth === 0 ? 0.5 : (bar.close - lower) / bbWidth;

      // ATR as percentage of price
      const atrPct = (currAtr / bar.close) * 100;

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // --- BUY logic ---
      if (!hasLong) {
        const belowLower = bar.close < lower;
        const rsiOversoldCondition = currRsi < rsiOversold;
        const rsiTurningUp = currRsi > prevRsi;
        const trendOk = useTrendFilter === 0 || bar.close > currSma200;
        const atrOk = atrPct < maxAtrPctFilter;

        if (belowLower && rsiOversoldCondition && rsiTurningUp && trendOk && atrOk) {
          // Confidence components
          const percentBComponent = 0.2 * (1 - Math.max(percentB, 0));
          const rsiReversal = Math.min(
            Math.max((rsiOversold - currRsi) / 20 + (currRsi - prevRsi) / 10, 0),
            1,
          );
          const rsiComponent = 0.15 * rsiReversal;
          const trendAlignment = useTrendFilter && bar.close > currSma200 ? 1 : 0;
          const trendComponent = 0.1 * trendAlignment;
          const confidence = Math.min(0.4 + percentBComponent + rsiComponent + trendComponent, 1);

          const stopLoss = bar.close - atrStopMultiplier * currAtr;
          const takeProfit = middle;
          const sizePct = Math.min(maxSizePct, Math.max(20, confidence * 80));

          // Store tracking state in memory
          ctx.memory.set("holdBars", 0);
          ctx.memory.set("entryPercentB", percentB);

          return {
            action: "buy",
            symbol,
            sizePct,
            orderType: "market",
            reason: `BB lower touch (percentB=${percentB.toFixed(3)}) + RSI oversold (${currRsi.toFixed(1)}) turning up`,
            confidence,
            stopLoss,
            takeProfit,
          };
        }
      }

      // --- SELL logic ---
      if (hasLong) {
        // Increment hold bar counter
        const holdBars = ((ctx.memory.get("holdBars") as number) ?? 0) + 1;
        ctx.memory.set("holdBars", holdBars);

        // Mean reversion target reached
        if (bar.close >= middle) {
          ctx.memory.delete("holdBars");
          ctx.memory.delete("entryPercentB");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `Mean reversion target: price ${bar.close.toFixed(2)} >= BB middle ${middle.toFixed(2)}`,
            confidence: 0.8,
          };
        }

        // Overbought exit
        if (currRsi > rsiOverbought) {
          ctx.memory.delete("holdBars");
          ctx.memory.delete("entryPercentB");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `RSI overbought exit: RSI=${currRsi.toFixed(1)} > ${rsiOverbought}`,
            confidence: 0.75,
          };
        }

        // Time stop
        if (holdBars > 10) {
          ctx.memory.delete("holdBars");
          ctx.memory.delete("entryPercentB");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `Time stop: held ${holdBars} bars > 10 bar limit`,
            confidence: 0.6,
          };
        }
      }

      return null;
    },
  };
}
