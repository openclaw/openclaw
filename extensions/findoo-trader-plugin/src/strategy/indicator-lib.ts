import type { OHLCV, IndicatorLib } from "../shared/types.js";
import { sma, ema, rsi, macd, bollingerBands, atr } from "./indicators.js";

/** Build an IndicatorLib over history close/high/low arrays. */
export function buildIndicatorLib(history: OHLCV[]): IndicatorLib {
  const closes = history.map((b) => b.close);
  const highs = history.map((b) => b.high);
  const lows = history.map((b) => b.low);

  return {
    sma: (period: number) => sma(closes, period),
    ema: (period: number) => ema(closes, period),
    rsi: (period: number) => rsi(closes, period),
    macd: (fast?: number, slow?: number, signal?: number) => macd(closes, fast, slow, signal),
    bollingerBands: (period?: number, stdDev?: number) => bollingerBands(closes, period, stdDev),
    atr: (period?: number) => atr(highs, lows, closes, period),
  };
}

/** Progress report emitted during backtest simulation. */
export type BacktestProgress = {
  strategyId: string;
  currentBar: number;
  totalBars: number;
  percentComplete: number;
  currentEquity: number;
  status: "running" | "completed" | "error";
};
