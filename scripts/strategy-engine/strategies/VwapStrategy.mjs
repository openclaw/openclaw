import { VWAP } from "technicalindicators";
// VwapStrategy.mjs — VWAP 均量加權策略
// 移植自 TradingView VWAP + Standard Deviation Bands EA
// 開源參考：https://github.com/freqtrade/freqtrade-strategies (VWAP)
// 邏輯：價格從 VWAP 下方回升穿越 → 多；從上方跌破 → 空
// 搭配標準差帶過濾（可選）
import { BaseStrategy } from "../BaseStrategy.mjs";

export class VwapStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // deviationMult: 標準差倍數，0 = 純 VWAP 穿越，1~2 = 偏離帶反轉
    this.deviationMult = this.params.deviation ?? 0;
    this._prevAbove = null; // 上一根是否在 VWAP 上方
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < 3) {
      return;
    }

    const closes = this.closes();
    const highs = this.highs();
    const lows = this.lows();
    const volumes = this.volumes();

    const vwapVals = VWAP.calculate({
      high: highs,
      low: lows,
      close: closes,
      volume: volumes,
    });
    if (!vwapVals.length) {
      return;
    }
    const vwap = vwapVals[vwapVals.length - 1];
    const close = closes[closes.length - 1];

    // 計算 VWAP 偏離標準差（20根）
    let band = 0;
    if (this.deviationMult > 0) {
      const n = Math.min(20, vwapVals.length);
      const slice = vwapVals.slice(-n);
      const mean = slice.reduce((a, b) => a + b, 0) / n;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      band = this.deviationMult * Math.sqrt(variance);
    }

    const above = close > vwap + band;
    const below = close < vwap - band;

    if (this._prevAbove != null) {
      // 從 VWAP 下方穿越到上方 → 買
      if (!this._prevAbove && above && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", `VWAP 上穿平倉`, this.maxQty);
        }
        this.signal(
          "buy",
          `收盤 ${close.toFixed(2)} 向上穿越 VWAP ${vwap.toFixed(2)}`,
          this.maxQty,
        );
        this._position = 1;
      }
      // 從 VWAP 上方穿越到下方 → 賣
      else if (this._prevAbove && below && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", `VWAP 下穿平倉`, this.maxQty);
        }
        this.signal(
          "sell",
          `收盤 ${close.toFixed(2)} 向下穿越 VWAP ${vwap.toFixed(2)}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }
    this._prevAbove = above;
  }
}
