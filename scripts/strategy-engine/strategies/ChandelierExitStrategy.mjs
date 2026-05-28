import { ChandelierExit } from "technicalindicators";
// ChandelierExitStrategy.mjs — Chandelier Exit 趨勢跟蹤止損策略
// 移植自 TradingView Chandelier Exit by lazybear
// technicalindicators 返回 { exitLong, exitShort }
// exitLong  = highest(high, n) - mult * ATR  → 多頭停損線 (在價格下方)
// exitShort = lowest(low, n)   + mult * ATR  → 空頭停損線 (在價格上方)
// 方向判斷：close > exitLong → 多頭；close < exitShort → 空頭
import { BaseStrategy } from "../BaseStrategy.mjs";

export class ChandelierExitStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 22;
    this.multiplier = this.params.multiplier ?? 3;
    this._prevDir = null; // 1=long, -1=short
    this._position = 0;
  }

  _getDir(close, exitLong, exitShort) {
    if (close > exitLong) {
      return 1;
    } // 多頭：收盤在多頭止損線上方
    if (close < exitShort) {
      return -1;
    } // 空頭：收盤在空頭止損線下方
    return 0; // 中性
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const results = ChandelierExit.calculate({
      period: this.period,
      multiplier: this.multiplier,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (results.length < 2) {
      return;
    }

    const curr = results[results.length - 1];
    const closes = this.closes();
    const lastClose = closes[closes.length - 1];
    const dir = this._getDir(lastClose, curr.exitLong, curr.exitShort);

    if (dir !== 0 && this._prevDir !== null && dir !== this._prevDir) {
      if (dir === 1) {
        if (this._position === -1) {
          this.signal("close_short", "Chandelier Exit 翻多", this.maxQty);
        }
        this.signal(
          "buy",
          `CE 多頭止損=${curr.exitLong.toFixed(2)} 空頭止損=${curr.exitShort.toFixed(2)}`,
          this.maxQty,
        );
        this._position = 1;
      } else if (dir === -1) {
        if (this._position === 1) {
          this.signal("close_long", "Chandelier Exit 翻空", this.maxQty);
        }
        this.signal(
          "sell",
          `CE 空頭止損=${curr.exitShort.toFixed(2)} 多頭止損=${curr.exitLong.toFixed(2)}`,
          this.maxQty,
        );
        this._position = -1;
      }
    }
    if (dir !== 0) {
      this._prevDir = dir;
    }
  }
}
