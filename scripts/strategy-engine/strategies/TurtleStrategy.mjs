// TurtleStrategy.mjs — 海龜交易系統 (Donchian Channel)
// 移植自 Richard Dennis 海龜交易系統
// 開源參考：https://github.com/kieranrcampbell/turtletrading
// System 1: 20日高點突破進場，10日低點跌破出場 (多)
// System 2: 55日高點突破進場，20日低點跌破出場 (多/空均適用)
import { BaseStrategy } from "../BaseStrategy.mjs";

export class TurtleStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // system: 1 = 20/10, 2 = 55/20
    this.system = this.params.system ?? 2;
    this.entryN = this.system === 1 ? (this.params.entry ?? 20) : (this.params.entry ?? 55);
    this.exitN = this.system === 1 ? (this.params.exit ?? 10) : (this.params.exit ?? 20);
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.entryN + 1) {
      return;
    }

    const hist = this._priceHistory;

    // 進場通道：前 entryN 根 K 棒（不含最後一根）
    const entrySlice = hist.slice(-(this.entryN + 1), -1);
    const entryHigh = Math.max(...entrySlice.map((b) => b.high));
    const entryLow = Math.min(...entrySlice.map((b) => b.low));

    // 出場通道：前 exitN 根 K 棒（不含最後一根）
    const exitSlice = hist.slice(-(this.exitN + 1), -1);
    const exitHigh = Math.max(...exitSlice.map((b) => b.high));
    const exitLow = Math.min(...exitSlice.map((b) => b.low));

    const close = bar.close;

    if (this._position === 0 || this._position === -1) {
      // 突破進場做多
      if (close > entryHigh) {
        if (this._position === -1) {
          this.signal("close_short", `海龜 S${this.system} 空頭停損平倉`, this.maxQty);
        }
        this.signal(
          "buy",
          `海龜 S${this.system} 突破 ${this.entryN}日高點 ${entryHigh.toFixed(2)}`,
          this.maxQty,
        );
        this._position = 1;
      }
    }
    if (this._position === 0 || this._position === 1) {
      // 突破進場做空
      if (close < entryLow) {
        if (this._position === 1) {
          this.signal("close_long", `海龜 S${this.system} 多頭停損平倉`, this.maxQty);
        }
        this.signal(
          "sell",
          `海龜 S${this.system} 跌破 ${this.entryN}日低點 ${entryLow.toFixed(2)}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }

    // 出場：多頭跌破 exitN 低點
    if (this._position === 1 && close < exitLow) {
      this.signal(
        "close_long",
        `海龜 S${this.system} 多頭出場 跌破${this.exitN}日低點 ${exitLow.toFixed(2)}`,
        this.maxQty,
      );
      this._position = 0;
    }
    // 出場：空頭突破 exitN 高點
    if (this._position === -1 && close > exitHigh) {
      this.signal(
        "close_short",
        `海龜 S${this.system} 空頭出場 突破${this.exitN}日高點 ${exitHigh.toFixed(2)}`,
        this.maxQty,
      );
      this._position = 0;
    }
  }
}
