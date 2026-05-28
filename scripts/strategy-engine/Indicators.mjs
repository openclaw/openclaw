export function SMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period || period <= 0) {
    return null;
  }
  const slice = prices.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function EMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period || period <= 0) {
    return null;
  }
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < prices.length; i += 1) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function RSI(prices, period = 14) {
  if (!Array.isArray(prices) || prices.length < period + 1 || period <= 0) {
    return null;
  }
  const slice = prices.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const delta = slice[i] - slice[i - 1];
    if (delta > 0) {
      gains += delta;
    } else {
      losses -= delta;
    }
  }
  const rs = gains / (losses || 1e-10);
  return 100 - 100 / (1 + rs);
}

export function MACD(prices, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(prices) || prices.length < slow + signal) {
    return null;
  }
  const macdLine = [];
  for (let i = slow - 1; i < prices.length; i += 1) {
    const fastEma = EMA(prices.slice(0, i + 1), fast);
    const slowEma = EMA(prices.slice(0, i + 1), slow);
    if (fastEma != null && slowEma != null) {
      macdLine.push(fastEma - slowEma);
    }
  }
  const signalLine = EMA(macdLine, signal);
  const last = macdLine[macdLine.length - 1];
  return signalLine != null ? { macd: last, signal: signalLine, hist: last - signalLine } : null;
}

export function ATR(highs, lows, closes, period = 14) {
  if (
    !Array.isArray(highs) ||
    !Array.isArray(lows) ||
    !Array.isArray(closes) ||
    closes.length < period + 1 ||
    period <= 0
  ) {
    return null;
  }
  const trueRanges = [];
  for (let i = 1; i < closes.length; i += 1) {
    trueRanges.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  return SMA(trueRanges, period);
}

export function BollingerBands(prices, period = 20, stdDev = 2) {
  if (!Array.isArray(prices) || prices.length < period || period <= 0) {
    return null;
  }
  const slice = prices.slice(-period);
  const middle = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

export function Supertrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) {
    return null;
  }
  const atr = ATR(highs, lows, closes, period);
  if (!atr) {
    return null;
  }
  const last = closes.length - 1;
  const hl2 = (highs[last] + lows[last]) / 2;
  const upperBand = hl2 + multiplier * atr;
  const lowerBand = hl2 - multiplier * atr;
  const direction = closes[last] > lowerBand ? 1 : -1;
  return { value: direction === 1 ? lowerBand : upperBand, direction };
}

export function Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (
    !Array.isArray(highs) ||
    !Array.isArray(lows) ||
    !Array.isArray(closes) ||
    closes.length < kPeriod + dPeriod
  ) {
    return null;
  }
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i += 1) {
    const highSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...highSlice);
    const lowest = Math.min(...lowSlice);
    kValues.push(highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100);
  }
  return { k: kValues[kValues.length - 1], d: SMA(kValues, dPeriod) };
}
