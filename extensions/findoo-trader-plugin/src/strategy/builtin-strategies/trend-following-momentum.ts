import type { OHLCV } from "../../shared/types.js";
import type { Signal, StrategyContext, StrategyDefinition } from "../types.js";

/**
 * Trend-Following Momentum composite strategy.
 * Combines EMA crossover, MACD histogram confirmation, RSI filter,
 * and ATR-based dynamic stop-loss / take-profit with trailing stop.
 *
 * Buy when: EMA golden cross + MACD histogram rising & positive + RSI not overbought.
 * Sell when: EMA death cross OR MACD histogram turns negative OR trailing stop hit.
 */
export function createTrendFollowingMomentum(params?: {
  fastEma?: number;
  slowEma?: number;
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  rsiPeriod?: number;
  rsiOverbought?: number;
  atrPeriod?: number;
  atrStopMultiplier?: number;
  atrProfitMultiplier?: number;
  maxSizePct?: number;
  symbol?: string;
}): StrategyDefinition {
  const fastEma = params?.fastEma ?? 12;
  const slowEma = params?.slowEma ?? 26;
  const macdFast = params?.macdFast ?? 12;
  const macdSlow = params?.macdSlow ?? 26;
  const macdSignal = params?.macdSignal ?? 9;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const rsiOverbought = params?.rsiOverbought ?? 75;
  const atrPeriod = params?.atrPeriod ?? 14;
  const atrStopMultiplier = params?.atrStopMultiplier ?? 2.0;
  const atrProfitMultiplier = params?.atrProfitMultiplier ?? 3.0;
  const maxSizePct = params?.maxSizePct ?? 80;
  const symbol = params?.symbol ?? "BTC/USDT";

  return {
    id: "trend-following-momentum",
    name: "Trend-Following Momentum",
    version: "1.0.0",
    markets: ["crypto", "equity"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {
      fastEma,
      slowEma,
      macdFast,
      macdSlow,
      macdSignal,
      rsiPeriod,
      rsiOverbought,
      atrPeriod,
      atrStopMultiplier,
      atrProfitMultiplier,
      maxSizePct,
    },
    parameterRanges: {
      fastEma: { min: 5, max: 50, step: 1 },
      slowEma: { min: 10, max: 100, step: 2 },
      macdFast: { min: 8, max: 20, step: 2 },
      macdSlow: { min: 20, max: 40, step: 2 },
      macdSignal: { min: 5, max: 15, step: 1 },
      rsiPeriod: { min: 7, max: 28, step: 1 },
      rsiOverbought: { min: 65, max: 85, step: 5 },
      atrPeriod: { min: 7, max: 28, step: 1 },
      atrStopMultiplier: { min: 1.0, max: 4.0, step: 0.5 },
      atrProfitMultiplier: { min: 1.5, max: 6.0, step: 0.5 },
      maxSizePct: { min: 20, max: 100, step: 10 },
    },

    async onBar(bar: OHLCV, ctx: StrategyContext): Promise<Signal | null> {
      // Compute indicators
      const fastEmaArr = ctx.indicators.ema(fastEma);
      const slowEmaArr = ctx.indicators.ema(slowEma);
      const { histogram } = ctx.indicators.macd(macdFast, macdSlow, macdSignal);
      const rsiArr = ctx.indicators.rsi(rsiPeriod);
      const atrArr = ctx.indicators.atr(atrPeriod);

      const len = fastEmaArr.length;
      if (len < 2) return null;

      const currFast = fastEmaArr[len - 1]!;
      const currSlow = slowEmaArr[len - 1]!;
      const prevFast = fastEmaArr[len - 2]!;
      const prevSlow = slowEmaArr[len - 2]!;
      const currHist = histogram[len - 1]!;
      const prevHist = histogram[len - 2]!;
      const currRsi = rsiArr[len - 1]!;
      const currAtr = atrArr[len - 1]!;
      const prevClose =
        ctx.history.length >= 2 ? ctx.history[ctx.history.length - 2]!.close : bar.close;

      // Skip if any indicator value is NaN (warm-up period)
      if (
        Number.isNaN(currFast) ||
        Number.isNaN(currSlow) ||
        Number.isNaN(prevFast) ||
        Number.isNaN(prevSlow) ||
        Number.isNaN(currHist) ||
        Number.isNaN(prevHist) ||
        Number.isNaN(currRsi) ||
        Number.isNaN(currAtr)
      ) {
        return null;
      }

      // Skip during crisis regime
      if (ctx.regime === "crisis") return null;

      const hasLong = ctx.portfolio.positions.some((p) => p.side === "long");

      // --- SELL conditions (check first so trailing stop updates every bar) ---
      if (hasLong) {
        // Update trailing stop
        const storedStop = ctx.memory.get("trailingStop") as number | undefined;
        if (storedStop !== undefined) {
          const newStop = Math.max(storedStop, bar.close - atrStopMultiplier * currAtr);
          ctx.memory.set("trailingStop", newStop);

          // Trailing stop hit
          if (bar.close < newStop) {
            ctx.memory.delete("trailingStop");
            ctx.memory.delete("entryAtr");
            return {
              action: "sell",
              symbol,
              sizePct: 100,
              orderType: "market",
              reason: `Trailing stop hit: close=${bar.close.toFixed(2)} < stop=${newStop.toFixed(2)}`,
              confidence: 0.8,
            };
          }
        }

        // EMA death cross
        if (prevFast >= prevSlow && currFast < currSlow) {
          ctx.memory.delete("trailingStop");
          ctx.memory.delete("entryAtr");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `EMA death cross: fast(${fastEma})=${currFast.toFixed(2)} < slow(${slowEma})=${currSlow.toFixed(2)}`,
            confidence: 0.7,
          };
        }

        // MACD histogram turns negative
        if (currHist < 0) {
          ctx.memory.delete("trailingStop");
          ctx.memory.delete("entryAtr");
          return {
            action: "sell",
            symbol,
            sizePct: 100,
            orderType: "market",
            reason: `MACD histogram negative: ${currHist.toFixed(4)}`,
            confidence: 0.6,
          };
        }
      }

      // --- BUY conditions (all must be true) ---
      if (!hasLong) {
        const goldenCross = prevFast <= prevSlow && currFast > currSlow;
        const macdRising = currHist > 0 && currHist > prevHist;
        const rsiNotOverbought = currRsi < rsiOverbought;

        if (goldenCross && macdRising && rsiNotOverbought) {
          // Compute confidence components
          const histStrength = Math.min((Math.abs(currHist) / prevClose) * 1000, 1);
          const rsiScore = 1 - currRsi / 100;
          const emaSepScore = Math.min((Math.abs(currFast - currSlow) / prevClose) * 100, 1);
          const confidence = Math.max(
            0.3,
            Math.min(0.95, 0.5 + 0.15 * histStrength + 0.1 * rsiScore + 0.1 * emaSepScore),
          );

          // ATR-based stop-loss and take-profit
          const stopLoss = bar.close - atrStopMultiplier * currAtr;
          const takeProfit = bar.close + atrProfitMultiplier * currAtr;

          // Store trailing stop and entry ATR in memory
          ctx.memory.set("trailingStop", stopLoss);
          ctx.memory.set("entryAtr", currAtr);

          // Dynamic position sizing
          const sizePct = Math.min(maxSizePct, Math.max(20, confidence * 100));

          return {
            action: "buy",
            symbol,
            sizePct,
            orderType: "market",
            reason: `Trend-following buy: EMA golden cross + MACD histogram rising (${currHist.toFixed(4)}) + RSI=${currRsi.toFixed(1)}`,
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
