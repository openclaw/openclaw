import type { MarketRegime, OHLCV } from "./types.js";

/** Simple Moving Average over `period` values. */
function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i]!;
  }
  result.push(sum / period);
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    result.push(sum / period);
  }
  return result;
}

/** Average True Range over `period` bars. Returns one ATR value per bar after the first `period` bars. */
function atr(bars: OHLCV[], period: number): number[] {
  if (bars.length < 2) return [];

  // Calculate True Range for each bar (starting from index 1)
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i]!.high;
    const low = bars[i]!.low;
    const prevClose = bars[i - 1]!.close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }

  return sma(trValues, period);
}

export class RegimeDetector {
  detect(ohlcv: OHLCV[]): MarketRegime {
    if (ohlcv.length < 200) return "sideways";

    const closes = ohlcv.map((b) => b.close);
    const currentClose = closes[closes.length - 1]!;

    // 1. Drawdown from peak
    let peak = -Infinity;
    for (const c of closes) {
      if (c > peak) peak = c;
    }
    const drawdownPct = ((peak - currentClose) / peak) * 100;
    if (drawdownPct > 30) return "crisis";

    // 2. ATR% = ATR(14) / close * 100
    const atrValues = atr(ohlcv, 14);
    if (atrValues.length > 0) {
      const latestAtr = atrValues[atrValues.length - 1]!;
      const atrPct = (latestAtr / currentClose) * 100;
      if (atrPct > 4) return "volatile";
    }

    // 3. SMA crossover
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);

    if (sma50.length === 0 || sma200.length === 0) return "sideways";

    const latestSma50 = sma50[sma50.length - 1]!;
    const latestSma200 = sma200[sma200.length - 1]!;

    if (latestSma50 > latestSma200 && currentClose > latestSma50) return "bull";
    if (latestSma50 < latestSma200 && currentClose < latestSma50) return "bear";

    return "sideways";
  }
}
