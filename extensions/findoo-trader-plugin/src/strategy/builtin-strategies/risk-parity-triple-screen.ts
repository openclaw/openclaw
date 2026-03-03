import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Risk-Parity Triple Screen composite strategy.
 *
 * Applies Alexander Elder's Triple Screen method with risk-parity position sizing:
 *
 * Screen 1 (Tide): Long-term trend scored 0-3 via EMA crossover, MACD histogram,
 *   and SMA slope. Requires score >= 2 to pass.
 * Screen 2 (Wave): Medium-term pullback state machine — RSI must first dip below
 *   oversold threshold, then recover above entry level to confirm a reversal.
 * Screen 3 (Ripple): Short-term entry timing — price must be near the lower
 *   Bollinger Band (within 1% tolerance).
 *
 * Position sizing uses ATR-based risk parity: risk a fixed percentage of equity
 * per trade, with stop distance derived from ATR.
 *
 * Sell when: tide flips bearish, price touches upper BB, RSI overbought & reversing,
 * or time stop (20 bars) is hit.
 */
export function createRiskParityTripleScreen(params?: {
  tideFastEma?: number;
  tideSlowEma?: number;
  tideMacdFast?: number;
  tideMacdSlow?: number;
  tideMacdSignal?: number;
  tideSma?: number;
  tideSlopeLookback?: number;
  waveRsiPeriod?: number;
  waveRsiOversold?: number;
  waveRsiEntry?: number;
  rippleBbPeriod?: number;
  rippleBbStdDev?: number;
  atrPeriod?: number;
  riskPctPerTrade?: number;
  atrStopMultiplier?: number;
  atrProfitMultiplier?: number;
  maxSizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const tideFastEma = params?.tideFastEma ?? 13;
  const tideSlowEma = params?.tideSlowEma ?? 48;
  const tideMacdFast = params?.tideMacdFast ?? 12;
  const tideMacdSlow = params?.tideMacdSlow ?? 26;
  const tideMacdSignal = params?.tideMacdSignal ?? 9;
  const tideSma = params?.tideSma ?? 50;
  const tideSlopeLookback = params?.tideSlopeLookback ?? 5;
  const waveRsiPeriod = params?.waveRsiPeriod ?? 14;
  const waveRsiOversold = params?.waveRsiOversold ?? 40;
  const waveRsiEntry = params?.waveRsiEntry ?? 50;
  const rippleBbPeriod = params?.rippleBbPeriod ?? 20;
  const rippleBbStdDev = params?.rippleBbStdDev ?? 2.0;
  const atrPeriod = params?.atrPeriod ?? 14;
  const riskPctPerTrade = params?.riskPctPerTrade ?? 2.0;
  const atrStopMultiplier = params?.atrStopMultiplier ?? 2.0;
  const atrProfitMultiplier = params?.atrProfitMultiplier ?? 3.5;
  const maxSizePct = params?.maxSizePct ?? 80;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "risk-parity-triple-screen",
    name: "Risk-Parity Triple Screen",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {
      tideFastEma,
      tideSlowEma,
      tideMacdFast,
      tideMacdSlow,
      tideMacdSignal,
      tideSma,
      tideSlopeLookback,
      waveRsiPeriod,
      waveRsiOversold,
      waveRsiEntry,
      rippleBbPeriod,
      rippleBbStdDev,
      atrPeriod,
      riskPctPerTrade,
      atrStopMultiplier,
      atrProfitMultiplier,
      maxSizePct,
    },
    parameterRanges: {
      tideFastEma: { min: 5, max: 30, step: 1 },
      tideSlowEma: { min: 20, max: 100, step: 2 },
      tideMacdFast: { min: 8, max: 20, step: 2 },
      tideMacdSlow: { min: 20, max: 40, step: 2 },
      tideMacdSignal: { min: 5, max: 15, step: 1 },
      tideSma: { min: 20, max: 100, step: 5 },
      tideSlopeLookback: { min: 3, max: 10, step: 1 },
      waveRsiPeriod: { min: 5, max: 28, step: 1 },
      waveRsiOversold: { min: 25, max: 45, step: 5 },
      waveRsiEntry: { min: 40, max: 60, step: 5 },
      rippleBbPeriod: { min: 10, max: 40, step: 5 },
      rippleBbStdDev: { min: 1.0, max: 3.0, step: 0.25 },
      atrPeriod: { min: 7, max: 28, step: 1 },
      riskPctPerTrade: { min: 0.5, max: 5.0, step: 0.5 },
      atrStopMultiplier: { min: 1.0, max: 4.0, step: 0.5 },
      atrProfitMultiplier: { min: 2.0, max: 6.0, step: 0.5 },
      maxSizePct: { min: 20, max: 100, step: 10 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      // 1. Compute all indicators
      const tideFastEmaArr = ctx.indicators.ema(tideFastEma);
      const tideSlowEmaArr = ctx.indicators.ema(tideSlowEma);
      const { histogram: macdHistogram } = ctx.indicators.macd(
        tideMacdFast,
        tideMacdSlow,
        tideMacdSignal,
      );
      const sma50Arr = ctx.indicators.sma(tideSma);
      const rsiArr = ctx.indicators.rsi(waveRsiPeriod);
      const bb = ctx.indicators.bollingerBands(rippleBbPeriod, rippleBbStdDev);
      const atrArr = ctx.indicators.atr(atrPeriod);

      const len = tideFastEmaArr.length;
      if (len < 2) return null;

      const currTideFastEma = tideFastEmaArr[len - 1]!;
      const currTideSlowEma = tideSlowEmaArr[len - 1]!;
      const currMacdHistogram = macdHistogram[len - 1]!;
      const currSma50 = sma50Arr[len - 1]!;
      const currRsi = rsiArr[len - 1]!;
      const prevRsi = rsiArr[len - 2]!;
      const currBBUpper = bb.upper[len - 1]!;
      const currBBLower = bb.lower[len - 1]!;
      const currAtr = atrArr[len - 1]!;

      // SMA value from tideSlopeLookback bars ago
      const slopeLookbackIdx = len - 1 - tideSlopeLookback;
      const pastSma50 = slopeLookbackIdx >= 0 ? sma50Arr[slopeLookbackIdx]! : NaN;

      // 2. NaN guard
      if (
        Number.isNaN(currTideFastEma) ||
        Number.isNaN(currTideSlowEma) ||
        Number.isNaN(currMacdHistogram) ||
        Number.isNaN(currSma50) ||
        Number.isNaN(pastSma50) ||
        Number.isNaN(currRsi) ||
        Number.isNaN(prevRsi) ||
        Number.isNaN(currBBUpper) ||
        Number.isNaN(currBBLower) ||
        Number.isNaN(currAtr)
      ) {
        return null;
      }

      // 3. Regime filter
      if (ctx.regime === "crisis") return null;

      // 4. Position check
      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // 5. Screen 1: Tide (long-term trend, scored 0-3)
      const emaBullish = currTideFastEma > currTideSlowEma;
      const macdPositive = currMacdHistogram > 0;
      const smaSloping = currSma50 > pastSma50;

      const tideScore = (emaBullish ? 1 : 0) + (macdPositive ? 1 : 0) + (smaSloping ? 1 : 0);
      const tidePassed = tideScore >= 2;

      // 6. Screen 2: Wave (medium-term pullback state machine)
      let waveWasOversold = (ctx.memory.get("waveWasOversold") as boolean) ?? false;

      if (currRsi < waveRsiOversold) {
        waveWasOversold = true;
      }
      ctx.memory.set("waveWasOversold", waveWasOversold);

      const wavePassed = waveWasOversold && currRsi > waveRsiEntry;

      // If wave passed, consume the signal (reset state)
      if (wavePassed) {
        ctx.memory.set("waveWasOversold", false);
      }

      // 7. Screen 3: Ripple (short-term entry timing — near lower BB)
      const ripplePassed = bar.close <= currBBLower * 1.01;

      // 8. BUY conditions
      if (!hasLong && tidePassed && wavePassed && ripplePassed) {
        // Risk-parity position sizing
        const stopDistance = atrStopMultiplier * currAtr;
        const riskAmount = ctx.portfolio.equity * (riskPctPerTrade / 100);
        const sharesFromRisk = riskAmount / stopDistance;
        const positionValue = sharesFromRisk * bar.close;
        const sizePct = Math.min(
          maxSizePct,
          Math.max(10, (positionValue / ctx.portfolio.equity) * 100),
        );

        // Confidence: base 0.4, plus component bonuses
        const confidence = Math.min(
          0.95,
          Math.max(0.3, 0.4 + 0.1 * tideScore + (wavePassed ? 0.15 : 0) + (ripplePassed ? 0.1 : 0)),
        );

        const stopLoss = bar.close - stopDistance;
        const takeProfit = bar.close + atrProfitMultiplier * currAtr;

        // Store entry metadata in memory
        ctx.memory.set("screens", {
          tide: tideScore,
          wave: true,
          ripple: true,
        });
        ctx.memory.set("entryBar", ctx.history.length);
        ctx.memory.set("entryPrice", bar.close);

        return {
          action: "buy",
          symbol,
          sizePct,
          orderType: "market",
          reason: `Triple Screen buy: tide=${tideScore}/3, wave=oversold-recovery, ripple=near-BB-lower (close=${bar.close.toFixed(2)}, BBL=${currBBLower.toFixed(2)})`,
          confidence,
          stopLoss,
          takeProfit,
        };
      }

      // 9. SELL conditions
      if (hasLong) {
        // Tide flips bearish
        if (tideScore < 2) {
          ctx.memory.delete("screens");
          ctx.memory.delete("entryBar");
          ctx.memory.delete("entryPrice");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `Tide bearish: tideScore=${tideScore} < 2`,
            confidence: 0.7,
          };
        }

        // BB upper touch
        if (bar.close >= currBBUpper) {
          ctx.memory.delete("screens");
          ctx.memory.delete("entryBar");
          ctx.memory.delete("entryPrice");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `BB upper touch: close=${bar.close.toFixed(2)} >= BBU=${currBBUpper.toFixed(2)}`,
            confidence: 0.75,
          };
        }

        // RSI extreme + reversal
        if (currRsi > 80 && currRsi < prevRsi) {
          ctx.memory.delete("screens");
          ctx.memory.delete("entryBar");
          ctx.memory.delete("entryPrice");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `RSI overbought reversal: RSI=${currRsi.toFixed(1)} > 80 and declining`,
            confidence: 0.7,
          };
        }

        // Time stop
        const entryBar = ctx.memory.get("entryBar") as number | undefined;
        if (entryBar !== undefined && ctx.history.length - entryBar > 20) {
          ctx.memory.delete("screens");
          ctx.memory.delete("entryBar");
          ctx.memory.delete("entryPrice");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `Time stop: held ${ctx.history.length - entryBar} bars > 20 limit`,
            confidence: 0.6,
          };
        }
      }

      return null;
    },
  };
}
