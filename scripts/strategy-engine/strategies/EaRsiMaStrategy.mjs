/**
 * EaRsiMaStrategy — RSI + 均線交叉 EA
 * 每 tick 計算 RSI + EMA 交叉，即時進出場
 * 多頭：RSI < 超賣 + 快線在慢線上方 → 買入
 * 空頭：RSI > 超買 + 快線在慢線下方 → 賣出
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaRsiMaStrategy extends EaBaseStrategy {
  constructor(config) {
    super(config);
    this._overbought = this.params.overbought ?? 70;
    this._oversold = this.params.oversold ?? 30;
  }

  eaTick(tick, ind) {
    const { rsi, ema_fast, ema_slow, price } = ind;
    const bullMa = ema_fast > ema_slow;
    const bearMa = ema_fast < ema_slow;

    // 出場：RSI 回到中間區域
    if (this._position === 1 && rsi > this._overbought) {
      return { action: "close", reason: `RSI超買${rsi.toFixed(1)} 平多` };
    }
    if (this._position === -1 && rsi < this._oversold) {
      return { action: "close", reason: `RSI超賣${rsi.toFixed(1)} 平空` };
    }

    // 進場
    if (rsi < this._oversold && bullMa && this._position !== 1) {
      return { action: "buy", reason: `RSI${rsi.toFixed(1)}<${this._oversold} + EMA金叉` };
    }
    if (rsi > this._overbought && bearMa && this._position !== -1) {
      return { action: "sell", reason: `RSI${rsi.toFixed(1)}>${this._overbought} + EMA死叉` };
    }
    return null;
  }
}

export default EaRsiMaStrategy;
