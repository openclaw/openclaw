/**
 * EaBollingerStrategy — 布林通道 squeeze + breakout EA
 * 通道收窄（squeeze）後突破方向跟進
 * 觸及反向通道邊界出場
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaBollingerStrategy extends EaBaseStrategy {
  constructor(config) {
    super(config);
    this._squeezeRatio = this.params.squeezeRatio ?? 0.5; // 通道寬/均線 < 此值視為 squeeze
    this._prevBandWidth = Infinity;
  }

  eaTick(tick, ind) {
    const { bb, price } = ind;
    const bandWidth = (bb.upper - bb.lower) / bb.middle;
    const isSqueeze = bandWidth < this._squeezeRatio * 0.01;
    const wasWider = this._prevBandWidth > bandWidth;
    this._prevBandWidth = bandWidth;

    // 突破上軌 → 多
    if (price > bb.upper && this._position !== 1) {
      return { action: "buy", reason: `突破上軌${bb.upper.toFixed(2)} squeeze=${isSqueeze}` };
    }
    // 跌破下軌 → 空
    if (price < bb.lower && this._position !== -1) {
      return { action: "sell", reason: `跌破下軌${bb.lower.toFixed(2)} squeeze=${isSqueeze}` };
    }
    // 回中軌出場
    if (this._position === 1 && price <= bb.middle) {
      return { action: "close", reason: `回中軌${bb.middle.toFixed(2)} 平多` };
    }
    if (this._position === -1 && price >= bb.middle) {
      return { action: "close", reason: `回中軌${bb.middle.toFixed(2)} 平空` };
    }
    return null;
  }
}

export default EaBollingerStrategy;
