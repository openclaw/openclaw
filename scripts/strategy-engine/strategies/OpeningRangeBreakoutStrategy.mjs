// OpeningRangeBreakoutStrategy.mjs — 開盤區間突破策略 (ORB)
// 移植自 MT4/MT5 Opening Range Breakout EA
// 開源參考：https://www.mql5.com/en/code/32034
// 邏輯：記錄開盤後前 N 分鐘的最高/最低價，
//       價格向上突破高點 → 買；向下跌破低點 → 賣
//       每日 sessionEndHour 後清除狀態
import { BaseStrategy } from "../BaseStrategy.mjs";

export class OpeningRangeBreakoutStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // sessionStartHour: 開盤時間（24h 格式，台指 = 8, ES/NQ = 21 台灣時間）
    this.sessionStartHour = this.params.sessionStartHour ?? 8;
    this.sessionEndHour = this.params.sessionEndHour ?? 13;
    // rangeMins: 建立區間的分鐘數
    this.rangeMins = this.params.rangeMins ?? 30;
    this._orbHigh = null;
    this._orbLow = null;
    this._orbReady = false;
    this._rangeEnd = null; // Date 物件
    this._lastDay = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const time = new Date(bar.time);
    const h = time.getHours();
    const day = time.toDateString();

    // 每日重置
    if (this._lastDay !== day) {
      this._orbHigh = null;
      this._orbLow = null;
      this._orbReady = false;
      this._rangeEnd = null;
      this._position = 0;
      this._lastDay = day;
    }

    // 確認是否在有效交易時段
    if (h < this.sessionStartHour || h >= this.sessionEndHour) {
      return;
    }

    // 建立 ORB 區間：開盤後 rangeMins 分鐘
    if (!this._orbReady) {
      if (this._rangeEnd == null) {
        this._rangeEnd = new Date(time.getTime() + this.rangeMins * 60000);
      }
      if (this._orbHigh == null) {
        this._orbHigh = bar.high;
        this._orbLow = bar.low;
      } else {
        this._orbHigh = Math.max(this._orbHigh, bar.high);
        this._orbLow = Math.min(this._orbLow, bar.low);
      }
      if (time >= this._rangeEnd) {
        this._orbReady = true;
        console.log(
          `[ORB] 區間確立 High=${this._orbHigh.toFixed(2)} Low=${this._orbLow.toFixed(2)}`,
        );
      }
      return;
    }

    const close = bar.close;

    // 突破 ORB 高點 → 做多
    if (close > this._orbHigh && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", "ORB 多頭突破平空", this.maxQty);
      }
      this.signal("buy", `ORB 突破高點 ${this._orbHigh.toFixed(2)}`, this.maxQty);
      this._position = 1;
    }
    // 跌破 ORB 低點 → 做空
    else if (close < this._orbLow && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", "ORB 空頭跌破平多", this.maxQty);
      }
      this.signal("sell", `ORB 跌破低點 ${this._orbLow.toFixed(2)}`, this.maxQty);
      this._position = -1;
    }
  }
}
