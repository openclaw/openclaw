import { Stochastic } from "technicalindicators";
// StochasticStrategy.mjs — KD 隨機指標策略
// 移植自 MT4 Stochastic EA 經典邏輯
import { BaseStrategy } from "../BaseStrategy.mjs";

export class StochasticStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 14; // %K period
    this.signalK = this.params.signalK ?? 3; // %K smoothing
    this.signalD = this.params.signalD ?? 3; // %D period
    this.oversold = this.params.oversold ?? 20;
    this.overbought = this.params.overbought ?? 80;
    this._prevK = null;
    this._prevD = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + this.signalD + 1) {
      return;
    }

    const results = Stochastic.calculate({
      period: this.period,
      signalPeriod: this.signalD,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (results.length < 2) {
      return;
    }

    const curr = results[results.length - 1];
    const prev = results[results.length - 2];
    const k = curr.k,
      d = curr.d;
    const pk = prev.k,
      pd = prev.d;

    // KD 黃金交叉 + 超賣區 → 買進
    if (pk <= pd && k > d && k < this.oversold + 10 && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `KD 黃金交叉 K=${k.toFixed(1)}`, this.maxQty);
      }
      this.signal("buy", `K=${k.toFixed(1)} ↑ D=${d.toFixed(1)} 超賣區`, this.maxQty);
      this._position = 1;
    }
    // KD 死亡交叉 + 超買區 → 賣出
    else if (pk >= pd && k < d && k > this.overbought - 10 && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `KD 死亡交叉 K=${k.toFixed(1)}`, this.maxQty);
      }
      this.signal("sell", `K=${k.toFixed(1)} ↓ D=${d.toFixed(1)} 超買區`, this.maxQty);
      this._position = -1;
    }
  }
}
