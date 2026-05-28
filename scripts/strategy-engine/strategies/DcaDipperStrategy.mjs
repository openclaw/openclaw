import { RSI } from "technicalindicators";
// DcaDipperStrategy.mjs — DCA 逢低加碼策略
// 移植自 Haehnchen/crypto-trading-bot dca-dipper 策略
// 開源：https://github.com/Haehnchen/crypto-trading-bot/blob/master/src/strategy/dca_dipper.js
// 邏輯：當 RSI 降至超賣且價格比上次進場低一定比例時，再次買入
//       當 RSI 回到健康水平時，全數平倉
import { BaseStrategy } from "../BaseStrategy.mjs";

export class DcaDipperStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.rsiPeriod = this.params.rsiPeriod ?? 14;
    this.oversold = this.params.oversold ?? 35; // RSI 買入門檻
    this.exitRsi = this.params.exitRsi ?? 60; // RSI 出場門檻
    this.dipPct = this.params.dipPct ?? 0.02; // 每次加碼需比前次便宜 2%
    this.maxEntries = this.params.maxEntries ?? 3; // 最多加碼次數
    this._entries = []; // [{ price, qty }]
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.rsiPeriod + 1) {
      return;
    }

    const results = RSI.calculate({ period: this.rsiPeriod, values: this.closes() });
    if (!results.length) {
      return;
    }
    const rsi = results[results.length - 1];
    const close = bar.close;

    // 出場：RSI 回升到健康區間
    if (this._entries.length > 0 && rsi >= this.exitRsi) {
      const totalQty = this._entries.reduce((s, e) => s + e.qty, 0);
      const avgCost = this._entries.reduce((s, e) => s + e.price * e.qty, 0) / totalQty;
      this.signal(
        "close_long",
        `DCA 出場 RSI=${rsi.toFixed(1)} 均成本=${avgCost.toFixed(2)} 現價=${close.toFixed(2)}`,
        totalQty,
      );
      this._entries = [];
      this._position = 0;
      return;
    }

    // 進場 / 加碼：RSI 超賣且（首次或比前次便宜 dipPct）
    if (rsi <= this.oversold && this._entries.length < this.maxEntries) {
      const lastPrice = this._entries.length
        ? this._entries[this._entries.length - 1].price
        : Infinity;
      if (close <= lastPrice * (1 - this.dipPct) || this._entries.length === 0) {
        this._entries.push({ price: close, qty: this.maxQty });
        this._position = 1;
        this.signal(
          "buy",
          `DCA 第 ${this._entries.length} 次進場 RSI=${rsi.toFixed(1)} 價=${close.toFixed(2)}`,
          this.maxQty,
        );
      }
    }
  }
}
