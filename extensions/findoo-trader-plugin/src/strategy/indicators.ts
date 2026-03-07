/**
 * Pure technical indicator functions. Zero external dependencies.
 * All functions return arrays the same length as the input, with NaN
 * for indices where the indicator cannot yet be computed (warm-up period).
 */

/** Simple Moving Average. */
export function sma(data: number[], period: number): number[] {
  const len = data.length;
  const result = new Array<number>(len);
  if (len === 0) return [];

  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += data[i];
    if (i < period - 1) {
      result[i] = NaN;
    } else {
      if (i >= period) sum -= data[i - period];
      result[i] = sum / period;
    }
  }
  return result;
}

/** Exponential Moving Average. Seeded with SMA of the first `period` values. */
export function ema(data: number[], period: number): number[] {
  const len = data.length;
  if (len === 0) return [];

  const result = new Array<number>(len);
  if (period > len) {
    result.fill(NaN);
    return result;
  }

  const k = 2 / (period + 1);

  // Seed: SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period - 1; i++) {
    sum += data[i];
    result[i] = NaN;
  }
  sum += data[period - 1];
  result[period - 1] = sum / period;

  // Subsequent values use the EMA formula
  for (let i = period; i < len; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * Returns values in [0, 100]. NaN during warm-up.
 */
export function rsi(data: number[], period: number): number[] {
  const len = data.length;
  if (len === 0) return [];

  const result = new Array<number>(len).fill(NaN);

  // Need at least period+1 data points to compute first RSI
  if (len < period + 1) return result;

  // Compute initial average gain/loss over first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Wilder's smoothing for subsequent values
  for (let i = period + 1; i < len; i++) {
    const change = data[i] - data[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * Moving Average Convergence Divergence.
 * Returns MACD line, signal line, and histogram.
 */
export function macd(
  data: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
  const len = data.length;
  if (len === 0) {
    return { macd: [], signal: [], histogram: [] };
  }

  const fastEma = ema(data, fast);
  const slowEma = ema(data, slow);

  // MACD line = fast EMA - slow EMA
  const macdLine = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(fastEma[i]) || Number.isNaN(slowEma[i])) {
      macdLine[i] = NaN;
    } else {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  // Signal line = EMA of MACD line (only over valid MACD values)
  // Find first valid MACD index
  let firstValid = -1;
  for (let i = 0; i < len; i++) {
    if (!Number.isNaN(macdLine[i])) {
      firstValid = i;
      break;
    }
  }

  const signalLine = new Array<number>(len).fill(NaN);
  const histogram = new Array<number>(len).fill(NaN);

  if (firstValid === -1 || len - firstValid < signal) {
    return { macd: macdLine, signal: signalLine, histogram };
  }

  // Compute EMA of the valid portion of MACD line
  const validMacd = macdLine.slice(firstValid);
  const signalEma = ema(validMacd, signal);

  for (let i = 0; i < signalEma.length; i++) {
    signalLine[firstValid + i] = signalEma[i];
    if (!Number.isNaN(signalEma[i]) && !Number.isNaN(macdLine[firstValid + i])) {
      histogram[firstValid + i] = macdLine[firstValid + i] - signalEma[i];
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Bollinger Bands: middle = SMA, upper/lower = middle +/- stdDev * multiplier.
 */
export function bollingerBands(
  data: number[],
  period = 20,
  stdDevMultiplier = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
  const len = data.length;
  if (len === 0) {
    return { upper: [], middle: [], lower: [] };
  }

  const middle = sma(data, period);
  const upper = new Array<number>(len);
  const lower = new Array<number>(len);

  for (let i = 0; i < len; i++) {
    if (Number.isNaN(middle[i])) {
      upper[i] = NaN;
      lower[i] = NaN;
    } else {
      // Compute standard deviation over the window
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = data[j] - middle[i];
        sumSq += diff * diff;
      }
      const sd = Math.sqrt(sumSq / period);
      upper[i] = middle[i] + stdDevMultiplier * sd;
      lower[i] = middle[i] - stdDevMultiplier * sd;
    }
  }

  return { upper, middle, lower };
}

/**
 * Average True Range (Wilder's smoothing).
 * True Range = max(H-L, |H-prevClose|, |L-prevClose|).
 */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const len = highs.length;
  if (len === 0) return [];

  const result = new Array<number>(len).fill(NaN);

  // Compute True Range array (first bar has no previous close, so TR = H - L)
  const tr = new Array<number>(len);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < len; i++) {
    const hl = highs[i] - lows[i];
    const hpc = Math.abs(highs[i] - closes[i - 1]);
    const lpc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hpc, lpc);
  }

  // Need at least `period` TRs to compute first ATR
  if (len < period + 1) return result;

  // First ATR = simple average of first `period` TRs (starting from index 1)
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  result[period] = sum / period;

  // Wilder's smoothing
  for (let i = period + 1; i < len; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }

  return result;
}
