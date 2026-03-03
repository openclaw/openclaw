import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Regime Adaptive composite strategy.
 *
 * Detects the local market regime (trend vs mean-reversion) using
 * Bollinger Band width and EMA separation, then applies the appropriate
 * sub-strategy logic. A 3-bar confirmation filter prevents whipsaw on
 * regime transitions, and a forced-exit mechanism closes stale positions
 * that were entered under a different regime.
 */
export function createRegimeAdaptive(params?: {
  bbPeriod?: number;
  fastEma?: number;
  slowEma?: number;
  rsiPeriod?: number;
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  atrPeriod?: number;
  bandWidthThreshold?: number;
  emaSepThreshold?: number;
  rsiOversoldMR?: number;
  rsiOverboughtMR?: number;
  rsiTrendMinimum?: number;
  atrStopMultiplier?: number;
  maxSizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const bbPeriod = params?.bbPeriod ?? 20;
  const fastEma = params?.fastEma ?? 12;
  const slowEma = params?.slowEma ?? 26;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const macdFast = params?.macdFast ?? 12;
  const macdSlow = params?.macdSlow ?? 26;
  const macdSignal = params?.macdSignal ?? 9;
  const atrPeriod = params?.atrPeriod ?? 14;
  const bandWidthThreshold = params?.bandWidthThreshold ?? 0.04;
  const emaSepThreshold = params?.emaSepThreshold ?? 0.02;
  const rsiOversoldMR = params?.rsiOversoldMR ?? 30;
  const rsiOverboughtMR = params?.rsiOverboughtMR ?? 70;
  const rsiTrendMinimum = params?.rsiTrendMinimum ?? 45;
  const atrStopMultiplier = params?.atrStopMultiplier ?? 2.0;
  const maxSizePct = params?.maxSizePct ?? 70;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "regime-adaptive",
    name: "Regime Adaptive",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {
      bbPeriod,
      fastEma,
      slowEma,
      rsiPeriod,
      macdFast,
      macdSlow,
      macdSignal,
      atrPeriod,
      bandWidthThreshold,
      emaSepThreshold,
      rsiOversoldMR,
      rsiOverboughtMR,
      rsiTrendMinimum,
      atrStopMultiplier,
      maxSizePct,
    },
    parameterRanges: {
      bbPeriod: { min: 10, max: 40, step: 5 },
      fastEma: { min: 5, max: 20, step: 1 },
      slowEma: { min: 15, max: 50, step: 1 },
      rsiPeriod: { min: 7, max: 28, step: 7 },
      macdFast: { min: 8, max: 20, step: 2 },
      macdSlow: { min: 20, max: 40, step: 2 },
      macdSignal: { min: 5, max: 15, step: 2 },
      atrPeriod: { min: 7, max: 28, step: 7 },
      bandWidthThreshold: { min: 0.02, max: 0.08, step: 0.01 },
      emaSepThreshold: { min: 0.01, max: 0.05, step: 0.005 },
      rsiOversoldMR: { min: 20, max: 40, step: 5 },
      rsiOverboughtMR: { min: 60, max: 80, step: 5 },
      rsiTrendMinimum: { min: 35, max: 55, step: 5 },
      atrStopMultiplier: { min: 1, max: 4, step: 0.5 },
      maxSizePct: { min: 30, max: 100, step: 10 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      // --- 1. Compute all indicators ---
      const bands = ctx.indicators.bollingerBands(bbPeriod, 2);
      const fastEmaArr = ctx.indicators.ema(fastEma);
      const slowEmaArr = ctx.indicators.ema(slowEma);
      const rsiArr = ctx.indicators.rsi(rsiPeriod);
      const macdResult = ctx.indicators.macd(macdFast, macdSlow, macdSignal);
      const atrArr = ctx.indicators.atr(atrPeriod);

      const len = bands.upper.length;
      if (len < 2) return null;

      // --- 2. NaN guard on all current values ---
      const currUpper = bands.upper[len - 1]!;
      const currLower = bands.lower[len - 1]!;
      const currMiddle = bands.middle[len - 1]!;
      const currFastEma = fastEmaArr[fastEmaArr.length - 1]!;
      const currSlowEma = slowEmaArr[slowEmaArr.length - 1]!;
      const currRsi = rsiArr[rsiArr.length - 1]!;
      const prevRsi = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2]! : Number.NaN;
      const currHist = macdResult.histogram[macdResult.histogram.length - 1]!;
      const prevHist =
        macdResult.histogram.length >= 2
          ? macdResult.histogram[macdResult.histogram.length - 2]!
          : Number.NaN;
      const currAtr = atrArr[atrArr.length - 1]!;

      if (
        Number.isNaN(currUpper) ||
        Number.isNaN(currLower) ||
        Number.isNaN(currMiddle) ||
        Number.isNaN(currFastEma) ||
        Number.isNaN(currSlowEma) ||
        Number.isNaN(currRsi) ||
        Number.isNaN(prevRsi) ||
        Number.isNaN(currHist) ||
        Number.isNaN(prevHist) ||
        Number.isNaN(currAtr)
      ) {
        return null;
      }

      // --- 3. Regime filter: crisis → sit out ---
      if (ctx.regime === "crisis") return null;

      // --- 4. Local regime detection ---
      const bandWidth = (currUpper - currLower) / currMiddle;
      const emaSep = Math.abs(currFastEma - currSlowEma) / bar.close;
      const detectedMode: "trend" | "mean-reversion" =
        bandWidth > bandWidthThreshold && emaSep > emaSepThreshold ? "trend" : "mean-reversion";

      // --- 5. 3-bar confirmation to prevent whipsaw ---
      let activeMode =
        (ctx.memory.get("activeMode") as "trend" | "mean-reversion" | undefined) ??
        "mean-reversion";
      let modeBarCount = (ctx.memory.get("modeBarCount") as number | undefined) ?? 0;

      if (detectedMode !== activeMode) {
        modeBarCount++;
        if (modeBarCount >= 3) {
          activeMode = detectedMode;
          modeBarCount = 0;
        }
      } else {
        modeBarCount = 0;
      }

      ctx.memory.set("activeMode", activeMode);
      ctx.memory.set("modeBarCount", modeBarCount);

      // --- 6. Position check ---
      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // --- 9. Regime-switch forced exit (checked before entry logic) ---
      if (hasLong) {
        const entryMode = ctx.memory.get("entryMode") as "trend" | "mean-reversion" | undefined;
        if (entryMode !== undefined && entryMode !== activeMode) {
          let switchBars = (ctx.memory.get("switchBars") as number | undefined) ?? 0;
          switchBars++;
          ctx.memory.set("switchBars", switchBars);
          if (switchBars >= 5) {
            ctx.memory.delete("entryMode");
            ctx.memory.delete("switchBars");
            return {
              action: "sell",
              symbol,
              sizePct: 100,
              orderType: "market",
              reason: "regime switch forced exit",
              confidence: 0.5,
            };
          }
        } else if (entryMode === activeMode) {
          ctx.memory.set("switchBars", 0);
        }
      }

      // --- 7. Trend mode logic ---
      if (activeMode === "trend") {
        // BUY: bullish EMA crossover + rising MACD histogram + RSI above minimum
        if (
          !hasLong &&
          currFastEma > currSlowEma &&
          currHist > prevHist &&
          currRsi > rsiTrendMinimum
        ) {
          // Confidence: 0.5 base + alignment bonuses
          const emaSepStrength = Math.min(emaSep / (emaSepThreshold * 3), 0.15);
          const macdStrength = Math.min(Math.abs(currHist - prevHist) / (bar.close * 0.005), 0.15);
          const rsiBonus = Math.min((currRsi - rsiTrendMinimum) / 100, 0.15);
          const confidence = Math.min(
            0.95,
            Math.max(0.3, 0.5 + emaSepStrength + macdStrength + rsiBonus),
          );
          const sizePctCalc = Math.min(maxSizePct, Math.max(20, confidence * 90));

          ctx.memory.set("entryMode", activeMode);

          return {
            action: "buy",
            symbol,
            sizePct: sizePctCalc,
            orderType: "market",
            stopLoss: bar.close - atrStopMultiplier * currAtr,
            takeProfit: bar.close + 3 * currAtr,
            reason: `trend buy: fastEMA>${slowEma} EMA, MACD rising, RSI=${currRsi.toFixed(1)}`,
            confidence,
          };
        }

        // SELL: death cross OR MACD negative
        if (hasLong && (currFastEma < currSlowEma || currHist < 0)) {
          ctx.memory.delete("entryMode");
          ctx.memory.delete("switchBars");
          const reason =
            currFastEma < currSlowEma
              ? `trend sell: EMA death cross (fast=${currFastEma.toFixed(2)} < slow=${currSlowEma.toFixed(2)})`
              : `trend sell: MACD histogram negative (${currHist.toFixed(4)})`;
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason,
            confidence: 0.6,
          };
        }
      }

      // --- 8. Mean-reversion mode logic ---
      if (activeMode === "mean-reversion") {
        // BUY: below lower BB + RSI oversold + RSI turning up
        if (!hasLong && bar.close < currLower && currRsi < rsiOversoldMR && currRsi > prevRsi) {
          // Confidence: 0.4 base + oversold depth + RSI reversal strength
          const oversoldDepth = Math.min((rsiOversoldMR - currRsi) / rsiOversoldMR, 0.25);
          const rsiReversal = Math.min((currRsi - prevRsi) / 10, 0.25);
          const confidence = Math.min(0.95, Math.max(0.3, 0.4 + oversoldDepth + rsiReversal));
          const sizePctCalc = Math.min(maxSizePct, Math.max(20, confidence * 90));

          ctx.memory.set("entryMode", activeMode);

          return {
            action: "buy",
            symbol,
            sizePct: sizePctCalc,
            orderType: "market",
            stopLoss: bar.close - 1.5 * currAtr,
            takeProfit: currMiddle,
            reason: `MR buy: close=${bar.close.toFixed(2)} < BB lower=${currLower.toFixed(2)}, RSI=${currRsi.toFixed(1)} turning up`,
            confidence,
          };
        }

        // SELL: price reverts to BB middle OR RSI overbought
        if (hasLong && (bar.close >= currMiddle || currRsi > rsiOverboughtMR)) {
          ctx.memory.delete("entryMode");
          ctx.memory.delete("switchBars");
          const reason =
            bar.close >= currMiddle
              ? `MR sell: price=${bar.close.toFixed(2)} reverted to BB middle=${currMiddle.toFixed(2)}`
              : `MR sell: RSI overbought=${currRsi.toFixed(1)} > ${rsiOverboughtMR}`;
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason,
            confidence: 0.55,
          };
        }
      }

      return null;
    },
  };
}
