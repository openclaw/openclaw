import { ADX } from "technicalindicators";
// AdxDiStrategy.mjs — ADX + DI 趨勢跟蹤策略
// 移植自 MT4 ADX EA / TradingView ADX DI Strategy
// 開源參考：https://www.mql5.com/en/code/11101
// 條件：ADX > threshold 且 +DI 上穿 -DI → 多
//       ADX > threshold 且 -DI 上穿 +DI → 空
import { BaseStrategy } from "../BaseStrategy.mjs";

export class AdxDiStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 14;
    this.threshold = this.params.threshold ?? 25; // ADX 趨勢強度門檻
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period * 2 + 1) {
      return;
    }

    const results = ADX.calculate({
      period: this.period,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (results.length < 2) {
      return;
    }

    const curr = results[results.length - 1];
    const prev = results[results.length - 2];
    const { adx, pdi, mdi } = curr;

    // 趨勢強度不足時忽略信號
    if (adx < this.threshold) {
      return;
    }

    // +DI 上穿 -DI → 多頭趨勢
    if (prev.pdi <= prev.mdi && pdi > mdi && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `ADX(${adx.toFixed(1)}) DI 翻多`, this.maxQty);
      }
      this.signal(
        "buy",
        `+DI(${pdi.toFixed(1)}) ↑ -DI(${mdi.toFixed(1)}) ADX=${adx.toFixed(1)}`,
        this.maxQty,
      );
      this._position = 1;
    }
    // -DI 上穿 +DI → 空頭趨勢
    else if (prev.mdi <= prev.pdi && mdi > pdi && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `ADX(${adx.toFixed(1)}) DI 翻空`, this.maxQty);
      }
      this.signal(
        "sell",
        `-DI(${mdi.toFixed(1)}) ↑ +DI(${pdi.toFixed(1)}) ADX=${adx.toFixed(1)}`,
        this.maxQty,
      );
      this._position = -1;
    }
  }
}
