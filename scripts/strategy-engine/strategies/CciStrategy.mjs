import { CCI } from "technicalindicators";
// CciStrategy.mjs — CCI 商品通道指數超買超賣策略
// 移植自 Haehnchen/crypto-trading-bot CCI 策略
import { BaseStrategy } from "../BaseStrategy.mjs";

export class CciStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 20;
    this.oversold = this.params.oversold ?? -100;
    this.overbought = this.params.overbought ?? 100;
    this._prevCci = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const results = CCI.calculate({
      period: this.period,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (!results.length) {
      return;
    }
    const cci = results[results.length - 1];

    if (this._prevCci != null) {
      // 從超賣區往上穿越 oversold → 買進
      if (this._prevCci <= this.oversold && cci > this.oversold && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", `CCI(${this.period}) 離開超賣區`, this.maxQty);
        }
        this.signal(
          "buy",
          `CCI(${this.period})=${cci.toFixed(1)} 突破 ${this.oversold}`,
          this.maxQty,
        );
        this._position = 1;
      }
      // 從超買區往下穿越 overbought → 賣出
      else if (this._prevCci >= this.overbought && cci < this.overbought && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", `CCI(${this.period}) 離開超買區`, this.maxQty);
        }
        this.signal(
          "sell",
          `CCI(${this.period})=${cci.toFixed(1)} 跌破 ${this.overbought}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }
    this._prevCci = cci;
  }
}
