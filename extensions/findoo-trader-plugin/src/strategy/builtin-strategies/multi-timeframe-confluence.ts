import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Multi-Timeframe Confluence composite strategy.
 *
 * Combines long-term trend alignment (SMA200, EMA50/20 structure) with
 * short-term pullback signals (RSI oversold, Bollinger Band lower touch)
 * to enter high-probability long positions during confirmed uptrends.
 *
 * Buy when: long-term uptrend confirmed (score >= 2) + short-term pullback
 * detected (score >= 1) + RSI turning up + total confluence >= minConfluenceScore.
 *
 * Sell when: SMA200 breakdown, EMA structure collapse, or ATR trailing stop hit.
 * Partial exit when RSI overbought + turning down (first occurrence only).
 */
export function createMultiTimeframeConfluence(params?: {
  longSma?: number;
  mediumEma?: number;
  shortEma?: number;
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  bbPeriod?: number;
  bbStdDev?: number;
  atrPeriod?: number;
  atrStopMultiplier?: number;
  atrProfitMultiplier?: number;
  maxSizePct?: number;
  minConfluenceScore?: number;
  symbol?: string;
}): StrategyDefinition {
  const longSma = params?.longSma ?? 200;
  const mediumEma = params?.mediumEma ?? 50;
  const shortEma = params?.shortEma ?? 20;
  const rsiPeriod = params?.rsiPeriod ?? 7;
  const rsiOversold = params?.rsiOversold ?? 35;
  const rsiOverbought = params?.rsiOverbought ?? 65;
  const bbPeriod = params?.bbPeriod ?? 10;
  const bbStdDev = params?.bbStdDev ?? 2.0;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrStopMultiplier = params?.atrStopMultiplier ?? 2.0;
  const atrProfitMultiplier = params?.atrProfitMultiplier ?? 3.0;
  const maxSizePct = params?.maxSizePct ?? 70;
  const minConfluenceScore = params?.minConfluenceScore ?? 3;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "multi-timeframe-confluence",
    name: "Multi-Timeframe Confluence",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {
      longSma,
      mediumEma,
      shortEma,
      rsiPeriod,
      rsiOversold,
      rsiOverbought,
      bbPeriod,
      bbStdDev,
      atrPeriod,
      atrStopMultiplier,
      atrProfitMultiplier,
      maxSizePct,
      minConfluenceScore,
    },
    parameterRanges: {
      longSma: { min: 50, max: 300, step: 50 },
      mediumEma: { min: 20, max: 100, step: 10 },
      shortEma: { min: 5, max: 50, step: 5 },
      rsiPeriod: { min: 3, max: 21, step: 2 },
      rsiOversold: { min: 20, max: 45, step: 5 },
      rsiOverbought: { min: 55, max: 80, step: 5 },
      bbPeriod: { min: 5, max: 30, step: 5 },
      bbStdDev: { min: 1.0, max: 3.0, step: 0.5 },
      atrPeriod: { min: 7, max: 28, step: 7 },
      atrStopMultiplier: { min: 1.0, max: 4.0, step: 0.5 },
      atrProfitMultiplier: { min: 1.5, max: 6.0, step: 0.5 },
      maxSizePct: { min: 20, max: 100, step: 10 },
      minConfluenceScore: { min: 2, max: 5, step: 1 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      // Compute all indicators
      const smaArr = ctx.indicators.sma(longSma);
      const medEmaArr = ctx.indicators.ema(mediumEma);
      const shortEmaArr = ctx.indicators.ema(shortEma);
      const rsiArr = ctx.indicators.rsi(rsiPeriod);
      const bb = ctx.indicators.bollingerBands(bbPeriod, bbStdDev);
      const atrArr = ctx.indicators.atr(atrPeriod);

      const len = smaArr.length;
      if (len < 2) return null;

      const currSma = smaArr[len - 1]!;
      const prevSma = smaArr[len - 2]!;
      const currEma50 = medEmaArr[len - 1]!;
      const currEma20 = shortEmaArr[len - 1]!;
      const currRsi = rsiArr[len - 1]!;
      const prevRsi = rsiArr[len - 2]!;
      const currBBLower = bb.lower[len - 1]!;
      const currAtr = atrArr[len - 1]!;

      // NaN guard: need at least longSma bars for SMA warmup
      if (
        Number.isNaN(currSma) ||
        Number.isNaN(prevSma) ||
        Number.isNaN(currEma50) ||
        Number.isNaN(currEma20) ||
        Number.isNaN(currRsi) ||
        Number.isNaN(prevRsi) ||
        Number.isNaN(currBBLower) ||
        Number.isNaN(currAtr)
      ) {
        return null;
      }

      // Regime filter: skip during crisis
      if (ctx.regime === "crisis") return null;

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // --- SELL / PARTIAL EXIT conditions (check first when holding) ---
      if (hasLong) {
        // Update highest close for trailing stop
        const storedHighest = (ctx.memory.get("highestClose") as number) ?? bar.close;
        const highestClose = Math.max(storedHighest, bar.close);
        ctx.memory.set("highestClose", highestClose);

        // Partial exit: RSI overbought reversal (one-time)
        const partialExitDone = ctx.memory.get("partialExitDone") as boolean | undefined;
        if (!partialExitDone && currRsi > rsiOverbought && currRsi < prevRsi) {
          ctx.memory.set("partialExitDone", true);
          return {
            action: "sell",
            symbol,
            sizePct: 50,
            orderType: "market",
            reason: "Partial exit: RSI overbought reversal",
            confidence: 0.7,
          };
        }

        // SMA200 breakdown: price fell below long-term trend
        if (bar.close < currSma) {
          ctx.memory.delete("longConfluence");
          ctx.memory.delete("shortConfluence");
          ctx.memory.delete("entryConfluence");
          ctx.memory.delete("highestClose");
          ctx.memory.delete("partialExitDone");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `SMA breakdown: close=${bar.close.toFixed(2)} < SMA(${longSma})=${currSma.toFixed(2)}`,
            confidence: 0.8,
          };
        }

        // EMA structure collapse: full bearish alignment
        if (currEma20 < currEma50 && currEma50 < currSma) {
          ctx.memory.delete("longConfluence");
          ctx.memory.delete("shortConfluence");
          ctx.memory.delete("entryConfluence");
          ctx.memory.delete("highestClose");
          ctx.memory.delete("partialExitDone");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `EMA structure collapse: EMA(${shortEma})=${currEma20.toFixed(2)} < EMA(${mediumEma})=${currEma50.toFixed(2)} < SMA(${longSma})=${currSma.toFixed(2)}`,
            confidence: 0.85,
          };
        }

        // Trailing stop: price dropped more than atrStopMultiplier * ATR from highest
        if (bar.close < highestClose - atrStopMultiplier * currAtr) {
          ctx.memory.delete("longConfluence");
          ctx.memory.delete("shortConfluence");
          ctx.memory.delete("entryConfluence");
          ctx.memory.delete("highestClose");
          ctx.memory.delete("partialExitDone");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `Trailing stop: close=${bar.close.toFixed(2)} < highest=${highestClose.toFixed(2)} - ${atrStopMultiplier}*ATR=${currAtr.toFixed(2)}`,
            confidence: 0.75,
          };
        }
      }

      // --- BUY conditions ---
      if (!hasLong) {
        // Long-term confluence scoring (3 items, each 0 or 1)
        const smaRising = currSma > prevSma && bar.close > currSma ? 1 : 0;
        const structure = bar.close > currEma50 && currEma50 > currSma ? 1 : 0;
        const emaStack = currEma20 > currEma50 ? 1 : 0;
        const longScore = smaRising + structure + emaStack;

        // Short-term pullback scoring (2 items)
        const rsiPullback = currRsi < rsiOversold ? 1 : 0;
        const bbTouch = bar.close <= currBBLower ? 1 : 0;
        const shortScore = rsiPullback + bbTouch;

        const totalScore = longScore + shortScore;

        // All conditions must be met
        const longTrendStrong = longScore >= 2;
        const pullbackHappening = shortScore >= 1;
        const rsiTurningUp = currRsi > prevRsi;
        const confluenceMet = totalScore >= minConfluenceScore;

        if (longTrendStrong && pullbackHappening && rsiTurningUp && confluenceMet) {
          // Confidence = 0.3 + 0.12 * totalScore, clamped [0.3, 0.95]
          const confidence = Math.max(0.3, Math.min(0.95, 0.3 + 0.12 * totalScore));

          const stopLoss = bar.close - atrStopMultiplier * currAtr;
          const takeProfit = bar.close + atrProfitMultiplier * currAtr;

          // Store state in memory
          ctx.memory.set("longConfluence", longScore);
          ctx.memory.set("shortConfluence", shortScore);
          ctx.memory.set("entryConfluence", totalScore);
          ctx.memory.set("highestClose", bar.close);
          ctx.memory.set("partialExitDone", false);

          // Dynamic position sizing
          const sizePct = Math.min(maxSizePct, Math.max(20, confidence * 90));

          return {
            action: "buy",
            symbol,
            sizePct,
            orderType: "market",
            reason: `Confluence buy: longScore=${longScore} shortScore=${shortScore} total=${totalScore} RSI=${currRsi.toFixed(1)}`,
            confidence,
            stopLoss,
            takeProfit,
          };
        }
      }

      return null;
    },
  };
}
