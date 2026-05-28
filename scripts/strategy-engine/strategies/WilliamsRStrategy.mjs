import { WilliamsR } from "technicalindicators";
// WilliamsRStrategy.mjs — Williams %R 超買超賣策略
// 移植自 MT4 Williams %R EA / Larry Williams 原版邏輯
// 開源參考：https://github.com/freqtrade/freqtrade-strategies
// %R < -80 超賣，回升穿越 -80 → 買
// %R > -20 超買，回落穿越 -20 → 賣
import { BaseStrategy } from "../BaseStrategy.mjs";

export class WilliamsRStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 14;
    this.oversold = this.params.oversold ?? -80;
    this.overbought = this.params.overbought ?? -20;
    this._prevWr = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const results = WilliamsR.calculate({
      period: this.period,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (!results.length) {
      return;
    }
    const wr = results[results.length - 1];

    if (this._prevWr != null) {
      // 超賣回升：從 < -80 穿越到 > -80
      if (this._prevWr <= this.oversold && wr > this.oversold && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", `WR(${this.period}) 離開超賣`, this.maxQty);
        }
        this.signal("buy", `%R=${wr.toFixed(1)} 穿越 ${this.oversold} 向上`, this.maxQty);
        this._position = 1;
      }
      // 超買回落：從 > -20 穿越到 < -20
      else if (this._prevWr >= this.overbought && wr < this.overbought && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", `WR(${this.period}) 離開超買`, this.maxQty);
        }
        this.signal("sell", `%R=${wr.toFixed(1)} 穿越 ${this.overbought} 向下`, this.maxQty);
        this._position = -1;
      }
    }
    this._prevWr = wr;
  }
}
