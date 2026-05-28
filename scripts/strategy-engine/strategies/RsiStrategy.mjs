import { RSI } from "technicalindicators";
// RsiStrategy.mjs — RSI 超買超賣反轉策略
// 移植自 Haehnchen/crypto-trading-bot RSI 策略
import { BaseStrategy } from "../BaseStrategy.mjs";

export class RsiStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 14;
    this.oversold = this.params.oversold ?? 30;
    this.overbought = this.params.overbought ?? 70;
    this._prevRsi = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const results = RSI.calculate({ period: this.period, values: this.closes() });
    if (!results.length) {
      return;
    }
    const rsi = results[results.length - 1];

    if (this._prevRsi != null) {
      if (this._prevRsi <= this.oversold && rsi > this.oversold && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", `RSI(${this.period}) 離開超賣區`, this.maxQty);
        }
        this.signal(
          "buy",
          `RSI(${this.period})=${rsi.toFixed(1)} 突破 ${this.oversold}`,
          this.maxQty,
        );
        this._position = 1;
      } else if (
        this._prevRsi >= this.overbought &&
        rsi < this.overbought &&
        this._position !== -1
      ) {
        if (this._position === 1) {
          this.signal("close_long", `RSI(${this.period}) 離開超買區`, this.maxQty);
        }
        this.signal(
          "sell",
          `RSI(${this.period})=${rsi.toFixed(1)} 跌破 ${this.overbought}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }
    this._prevRsi = rsi;
  }
}
