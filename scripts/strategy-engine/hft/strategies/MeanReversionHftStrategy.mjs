// MeanReversionHftStrategy.mjs — 高頻均值回歸策略
// 移植自 Renaissance Technologies 均值回歸研究 / Ernie Chan《Quantitative Trading》
// 開源參考：https://github.com/nickmccullum/algorithmic-trading/mean-reversion
//
// 邏輯：
//   微觀 VWAP 作為均值基準
//   price deviation = (price - VWAP) / stdDev
//   deviation > entryZ → 價格偏高 → 做空（等回歸）
//   deviation < -entryZ → 價格偏低 → 做多（等回歸）
//   |deviation| < exitZ → 回歸 → 平倉
import { TickBuffer } from "../TickBuffer.mjs";

export class MeanReversionHftStrategy {
  constructor(config) {
    this.name = config.name;
    this.instrument = config.instrument;
    this.broker = config.broker;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? false;

    this.vwapWindow = this.params.vwapWindow ?? 200; // VWAP 計算窗口 tick 數
    this.stdDevWindow = this.params.stdDevWindow ?? 100; // 標準差計算窗口
    this.entryZ = this.params.entryZ ?? 2.0; // 進場 Z-score
    this.exitZ = this.params.exitZ ?? 0.5; // 出場 Z-score
    this.stopZ = this.params.stopZ ?? 3.5; // 止損 Z-score
    this.holdMs = this.params.holdMs ?? 30000; // 最長持倉 30 秒
    this.orderQty = this.params.orderQty ?? 1;
    this.cooldownMs = this.params.cooldownMs ?? 1000;

    this._buf = new TickBuffer(1000);
    this._position = 0;
    this._entryPrice = 0;
    this._entryTime = 0;
    this._lastTradeAt = 0;
    this._signals = [];
    this._enabled = true;
  }

  onTick(tick) {
    this._buf.push({ ...tick, time: tick.time ?? Date.now() });
    const minBars = Math.max(this.vwapWindow, this.stdDevWindow) + 5;
    if (this._buf.size < minBars) {
      return;
    }
    const now = Date.now();
    if (now - this._lastTradeAt < this.cooldownMs) {
      return;
    }

    const price = this._buf.latest().price;
    const vwap = this._buf.vwap(this.vwapWindow);
    const std = this._buf.stdDev(this.stdDevWindow);
    if (std < 0.0001) {
      return;
    }

    const z = (price - vwap) / std;

    // 持倉中檢查
    if (this._position !== 0) {
      const elapsed = now - this._entryTime;
      // 回歸出場
      if (Math.abs(z) < this.exitZ) {
        this._exit(price, `均值回歸 Z=${z.toFixed(2)} 回歸出場`);
        return;
      }
      // 止損：偏離更嚴重
      if (Math.abs(z) > this.stopZ) {
        this._exit(price, `均值回歸止損 Z=${z.toFixed(2)}`);
        return;
      }
      // 超時平倉
      if (elapsed >= this.holdMs) {
        this._exit(price, `均值回歸超時 ${(elapsed / 1000).toFixed(0)}s`);
        return;
      }
      return;
    }

    // 進場
    const reason = `MR Z=${z.toFixed(3)} VWAP=${vwap.toFixed(2)} σ=${std.toFixed(3)}`;
    if (z > this.entryZ) {
      // 價格偏高 → 做空，等回歸
      this._enter("sell", price, `↓ 高頻均值回歸 ${reason}`);
    } else if (z < -this.entryZ) {
      // 價格偏低 → 做多，等回歸
      this._enter("buy", price, `↑ 高頻均值回歸 ${reason}`);
    }
  }

  _enter(direction, price, reason) {
    this._position = direction === "buy" ? 1 : -1;
    this._entryPrice = price;
    this._entryTime = Date.now();
    this._lastTradeAt = Date.now();
    this._signals.push({
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      direction,
      qty: this.orderQty,
      price,
      reason,
      autoExecute: this.autoExecute,
    });
  }

  _exit(price, reason) {
    this._signals.push({
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      direction: this._position === 1 ? "close_long" : "close_short",
      qty: this.orderQty,
      price,
      reason,
      autoExecute: this.autoExecute,
    });
    this._position = 0;
    this._lastTradeAt = Date.now();
  }

  popSignals() {
    const s = [...this._signals];
    this._signals = [];
    return s;
  }
  get enabled() {
    return this._enabled;
  }
}
