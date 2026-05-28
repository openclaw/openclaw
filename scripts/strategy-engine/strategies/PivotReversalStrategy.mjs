// PivotReversalStrategy.mjs — Pivot 支撐壓力反轉策略
// 移植自 Haehnchen/crypto-trading-bot pivot-reversal 策略
// 開源：https://github.com/Haehnchen/crypto-trading-bot/blob/master/src/strategy/pivot_reversal.js
// 邏輯：找到 Pivot High / Pivot Low 後，在回測時進場
// Pivot High: bar[i].high 高於左右各 leftBars/rightBars 根
// Pivot Low : bar[i].low  低於左右各 leftBars/rightBars 根
import { BaseStrategy } from "../BaseStrategy.mjs";

function findPivotHigh(bars, i, left, right) {
  if (i < left || i + right >= bars.length) {
    return false;
  }
  const h = bars[i].high;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) {
      continue;
    }
    if (bars[j].high >= h) {
      return false;
    }
  }
  return true;
}

function findPivotLow(bars, i, left, right) {
  if (i < left || i + right >= bars.length) {
    return false;
  }
  const l = bars[i].low;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i) {
      continue;
    }
    if (bars[j].low <= l) {
      return false;
    }
  }
  return true;
}

export class PivotReversalStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.leftBars = this.params.leftBars ?? 4;
    this.rightBars = this.params.rightBars ?? 2;
    this._lastPivotHigh = null;
    this._lastPivotLow = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const hist = this._priceHistory;
    const n = hist.length;
    const minBars = this.leftBars + this.rightBars + 1;
    if (n < minBars) {
      return;
    }

    // 確認 rightBars 根前的 K 棒是否為 Pivot
    const checkIdx = n - 1 - this.rightBars;
    if (checkIdx < this.leftBars) {
      return;
    }

    if (findPivotHigh(hist, checkIdx, this.leftBars, this.rightBars)) {
      this._lastPivotHigh = hist[checkIdx].high;
    }
    if (findPivotLow(hist, checkIdx, this.leftBars, this.rightBars)) {
      this._lastPivotLow = hist[checkIdx].low;
    }

    const close = bar.close;

    // 價格回測到 Pivot Low 附近 → 支撐反彈做多
    if (this._lastPivotLow != null && close <= this._lastPivotLow * 1.002 && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `回測 Pivot Low 平空`, this.maxQty);
      }
      this.signal("buy", `回測 Pivot Low=${this._lastPivotLow.toFixed(2)}`, this.maxQty);
      this._position = 1;
      this._lastPivotLow = null;
    }
    // 價格回測到 Pivot High 附近 → 壓力反壓做空
    else if (
      this._lastPivotHigh != null &&
      close >= this._lastPivotHigh * 0.998 &&
      this._position !== -1
    ) {
      if (this._position === 1) {
        this.signal("close_long", `回測 Pivot High 平多`, this.maxQty);
      }
      this.signal("sell", `回測 Pivot High=${this._lastPivotHigh.toFixed(2)}`, this.maxQty);
      this._position = -1;
      this._lastPivotHigh = null;
    }
  }
}
