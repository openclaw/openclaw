/**
 * EaMacdStrategy — MACD 交叉 + 直方圖動量 EA
 * MACD 金叉 + histogram 正向放大 → 多
 * MACD 死叉 + histogram 負向放大 → 空
 */
import { EaBaseStrategy } from "./EaBaseStrategy.mjs";

export class EaMacdStrategy extends EaBaseStrategy {
  constructor(config) {
    super(config);
    this._histThreshold = this.params.histThreshold ?? 0;
    this._prevHistogram = 0;
  }

  eaTick(tick, ind) {
    const { macd } = ind;
    const hist = macd.histogram;
    const prevHist = this._prevHistogram;
    this._prevHistogram = hist;

    // 金叉：histogram 從負轉正
    if (prevHist <= 0 && hist > this._histThreshold && this._position !== 1) {
      return { action: "buy", reason: `MACD金叉 hist=${hist.toFixed(4)}` };
    }
    // 死叉：histogram 從正轉負
    if (prevHist >= 0 && hist < -this._histThreshold && this._position !== -1) {
      return { action: "sell", reason: `MACD死叉 hist=${hist.toFixed(4)}` };
    }
    // 動量減弱出場
    if (this._position === 1 && hist < prevHist && hist < 0) {
      return { action: "close", reason: `MACD動量減弱 平多` };
    }
    if (this._position === -1 && hist > prevHist && hist > 0) {
      return { action: "close", reason: `MACD動量減弱 平空` };
    }
    return null;
  }
}

export default EaMacdStrategy;
