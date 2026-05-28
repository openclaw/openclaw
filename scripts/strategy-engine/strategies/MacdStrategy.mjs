import { MACD } from "technicalindicators";
// MacdStrategy.mjs — MACD 柱狀圖翻轉策略
// 移植自 Haehnchen/crypto-trading-bot MACD 策略
import { BaseStrategy } from "../BaseStrategy.mjs";

export class MacdStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.fast = this.params.fast ?? 12;
    this.slow = this.params.slow ?? 26;
    this.signalPeriod = this.params.signal ?? 9;
    this._prevHist = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.slow + this.signalPeriod + 1) {
      return;
    }

    const results = MACD.calculate({
      values: this.closes(),
      fastPeriod: this.fast,
      slowPeriod: this.slow,
      signalPeriod: this.signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (!results.length) {
      return;
    }
    const last = results[results.length - 1];
    const hist = last.histogram;
    if (hist == null) {
      return;
    }

    if (this._prevHist != null) {
      if (this._prevHist < 0 && hist > 0 && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", "MACD hist turned positive", this.maxQty);
        }
        this.signal(
          "buy",
          `MACD hist=${hist.toFixed(4)} MACD=${last.MACD.toFixed(4)}`,
          this.maxQty,
        );
        this._position = 1;
      } else if (this._prevHist > 0 && hist < 0 && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", "MACD hist turned negative", this.maxQty);
        }
        this.signal(
          "sell",
          `MACD hist=${hist.toFixed(4)} MACD=${last.MACD.toFixed(4)}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }
    this._prevHist = hist;
  }
}
