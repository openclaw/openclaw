// BreakoutStrategy.mjs — N 根 K 棒最高/最低突破策略
// 移植自 LuxAlgo Breakout & Retest 核心邏輯
import { BaseStrategy } from "../BaseStrategy.mjs";

export class BreakoutStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.lookback = this.params.lookback ?? 20;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.lookback + 1) {
      return;
    }
    const prev = this._priceHistory.slice(-(this.lookback + 1), -1);
    const highN = Math.max(...prev.map((b) => b.high));
    const lowN = Math.min(...prev.map((b) => b.low));
    const curr = bar.close;

    if (curr > highN && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `Price broke ${this.lookback}-bar high`, this.maxQty);
      }
      this.signal("buy", `Breakout above ${highN.toFixed(2)}`, this.maxQty);
      this._position = 1;
    } else if (curr < lowN && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `Price broke ${this.lookback}-bar low`, this.maxQty);
      }
      this.signal("sell", `Breakdown below ${lowN.toFixed(2)}`, this.maxQty);
      this._position = -1;
    }
  }
}
