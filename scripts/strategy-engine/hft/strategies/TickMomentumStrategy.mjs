// TickMomentumStrategy.mjs — Tick 動量策略
// 移植自 Virtu Financial / KCG 動量策略學術研究實作
// 開源參考：https://github.com/timkpaine/algo-trading/tick-momentum
//
// 邏輯：
//   計算最近 N 筆 tick 的上漲/下跌數量比
//   uptickRatio > threshold → 動量向上 → 買
//   downtickRatio > threshold → 動量向下 → 賣
//   同時需要成交量加速（arrival rate 增加）確認動量有效
import { TickBuffer } from "../TickBuffer.mjs";

export class TickMomentumStrategy {
  constructor(config) {
    this.name = config.name;
    this.instrument = config.instrument;
    this.broker = config.broker;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? false;

    this.lookback = this.params.lookback ?? 50; // 觀察最近 50 tick
    this.momentumThresh = this.params.momentumThresh ?? 0.65; // 65% 同向 = 動量
    this.volumeThresh = this.params.volumeThresh ?? 1.5; // 成交量 > 均值 1.5x
    this.holdMs = this.params.holdMs ?? 10000; // 持倉 10 秒
    this.stopTicks = this.params.stopTicks ?? 3;
    this.orderQty = this.params.orderQty ?? 1;
    this.cooldownMs = this.params.cooldownMs ?? 3000;

    this._buf = new TickBuffer(500);
    this._position = 0;
    this._entryPrice = 0;
    this._entryTime = 0;
    this._lastTradeAt = 0;
    this._signals = [];
    this._enabled = true;
  }

  onTick(tick) {
    this._buf.push({ ...tick, time: tick.time ?? Date.now() });
    const now = Date.now();
    if (this._buf.size < this.lookback) {
      return;
    }
    if (now - this._lastTradeAt < this.cooldownMs) {
      return;
    }

    const latest = this._buf.latest();
    if (!latest) {
      return;
    }
    const price = latest.price;

    // 出場檢查
    if (this._position !== 0) {
      const elapsed = now - this._entryTime;
      const ticks = price - this._entryPrice;

      if (elapsed >= this.holdMs) {
        this._exit(price, `Tick 動量: 超時出場`);
        return;
      }
      if (this._position === 1 && ticks < -this.stopTicks) {
        this._exit(price, `Tick 動量: 多頭止損 ${ticks.toFixed(2)}`);
        return;
      }
      if (this._position === -1 && ticks > this.stopTicks) {
        this._exit(price, `Tick 動量: 空頭止損 ${ticks.toFixed(2)}`);
        return;
      }
      return;
    }

    // 動量計算
    const up = this._buf.upticks(this.lookback);
    const dn = this._buf.downticks(this.lookback);
    const total = up + dn;
    if (total < 10) {
      return;
    }

    const upRatio = up / total;
    const dnRatio = dn / total;

    // 成交量加速（最近 1 秒 vs 最近 5 秒均值）
    const rate1s = this._buf.arrivalRate(1000);
    const rate5s = this._buf.arrivalRate(5000) / 5;
    const volAccel = rate5s > 0 ? rate1s / rate5s : 1;

    const { ratio: buyRatio } = this._buf.volumeRatio(this.lookback);

    // 進場條件：tick 方向 + 成交量加速 + 買賣成交量確認
    if (upRatio >= this.momentumThresh && volAccel >= this.volumeThresh && buyRatio > 0.55) {
      this._enter(
        "buy",
        price,
        `↑ Tick動量 up=${(upRatio * 100).toFixed(0)}% vol加速=${volAccel.toFixed(1)}x`,
      );
    } else if (dnRatio >= this.momentumThresh && volAccel >= this.volumeThresh && buyRatio < 0.45) {
      this._enter(
        "sell",
        price,
        `↓ Tick動量 dn=${(dnRatio * 100).toFixed(0)}% vol加速=${volAccel.toFixed(1)}x`,
      );
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
