import { AwesomeOscillator } from "technicalindicators";
// AwesomeOscillatorStrategy.mjs — Awesome Oscillator 柱狀圖翻轉策略
// 移植自 Haehnchen/crypto-trading-bot AO 策略 (Bill Williams AO)
import { BaseStrategy } from "../BaseStrategy.mjs";

export class AwesomeOscillatorStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.fastPeriod = this.params.fast ?? 5;
    this.slowPeriod = this.params.slow ?? 34;
    this._prevAo = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.slowPeriod + 1) {
      return;
    }

    const results = AwesomeOscillator.calculate({
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
      high: this.highs(),
      low: this.lows(),
    });
    if (!results.length) {
      return;
    }
    const ao = results[results.length - 1];

    if (this._prevAo != null) {
      // AO 由負轉正 → 買進 (Saucer buy / zero-line cross)
      if (this._prevAo < 0 && ao > 0 && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", "AO 穿越零軸向上", this.maxQty);
        }
        this.signal("buy", `AO=${ao.toFixed(4)} 零軸向上穿越`, this.maxQty);
        this._position = 1;
      }
      // AO 由正轉負 → 賣出
      else if (this._prevAo > 0 && ao < 0 && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", "AO 穿越零軸向下", this.maxQty);
        }
        this.signal("sell", `AO=${ao.toFixed(4)} 零軸向下穿越`, this.maxQty);
        this._position = -1;
      }
    }
    this._prevAo = ao;
  }
}
