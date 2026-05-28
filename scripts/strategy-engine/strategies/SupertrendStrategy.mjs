import { ATR } from "technicalindicators";
// SupertrendStrategy.mjs — Supertrend 趨勢跟蹤策略
// 以 ATR 為基礎自建 Supertrend，移植自 LuxAlgo / TradingView Pine EA 邏輯
import { BaseStrategy } from "../BaseStrategy.mjs";

function calcSupertrend(highs, lows, closes, period, mult) {
  if (closes.length < period + 1) {
    return null;
  }

  const atrs = ATR.calculate({ period, high: highs, low: lows, close: closes });
  if (!atrs.length) {
    return null;
  }

  // Align ATR to closes (ATR has period-1 fewer elements)
  const offset = closes.length - atrs.length;
  const n = atrs.length;

  const upperBand = Array.from({ length: n });
  const lowerBand = Array.from({ length: n });
  const supertrend = Array.from({ length: n });
  const direction = Array.from({ length: n }); // 1=up (bullish), -1=down (bearish)

  for (let i = 0; i < n; i++) {
    const ci = i + offset;
    const hl2 = (highs[ci] + lows[ci]) / 2;
    upperBand[i] = hl2 + mult * atrs[i];
    lowerBand[i] = hl2 - mult * atrs[i];
  }

  // Adjust bands (no repainting)
  for (let i = 1; i < n; i++) {
    lowerBand[i] =
      lowerBand[i] > lowerBand[i - 1] || closes[i - 1 + offset] < lowerBand[i - 1]
        ? lowerBand[i]
        : lowerBand[i - 1];
    upperBand[i] =
      upperBand[i] < upperBand[i - 1] || closes[i - 1 + offset] > upperBand[i - 1]
        ? upperBand[i]
        : upperBand[i - 1];
  }

  // Compute supertrend
  supertrend[0] = closes[offset] > upperBand[0] ? lowerBand[0] : upperBand[0];
  direction[0] = closes[offset] > upperBand[0] ? 1 : -1;
  for (let i = 1; i < n; i++) {
    const ci = i + offset;
    if (supertrend[i - 1] === upperBand[i - 1]) {
      direction[i] = closes[ci] > upperBand[i] ? 1 : -1;
    } else {
      direction[i] = closes[ci] < lowerBand[i] ? -1 : 1;
    }
    supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
  }

  return { value: supertrend[n - 1], direction: direction[n - 1], prevDirection: direction[n - 2] };
}

export class SupertrendStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 10;
    this.multiplier = this.params.multiplier ?? 3;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 2) {
      return;
    }

    const st = calcSupertrend(
      this.highs(),
      this.lows(),
      this.closes(),
      this.period,
      this.multiplier,
    );
    if (!st || st.prevDirection == null) {
      return;
    }

    if (st.direction !== st.prevDirection) {
      if (st.direction === 1) {
        if (this._position === -1) {
          this.signal("close_short", "Supertrend 翻多", this.maxQty);
        }
        this.signal("buy", `Supertrend 支撐=${st.value.toFixed(2)}`, this.maxQty);
        this._position = 1;
      } else {
        if (this._position === 1) {
          this.signal("close_long", "Supertrend 翻空", this.maxQty);
        }
        this.signal("sell", `Supertrend 壓力=${st.value.toFixed(2)}`, this.maxQty);
        this._position = -1;
      }
    }
  }
}
