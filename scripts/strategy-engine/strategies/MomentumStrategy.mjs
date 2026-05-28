// MomentumStrategy.mjs — 動量突破策略
// 當價格突破 N 根 K 棒 SMA 且成交量確認時進場
import { BaseStrategy } from "../BaseStrategy.mjs";

export class MomentumStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 20;
    this.threshold = this.params.threshold ?? 0.5; // 動量門檻（百分比）
    this.stopLoss = this.params.stopLoss ?? 2.0; // 停損百分比
    this.takeProfit = this.params.takeProfit ?? 4.0; // 停利百分比
    this._entryPrice = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const closes = this.closes();
    const vols = this.volumes();
    const sma = this._sma(closes, this.period);
    const prevSma = this._sma(closes.slice(0, -1), this.period);
    const curr = bar.close;

    // 計算動量百分比
    const momentum = ((curr - sma) / sma) * 100;

    // 成交量確認：當前量 > 近 N 根平均量
    const avgVol = vols.slice(-this.period).reduce((a, b) => a + b, 0) / this.period;
    const volConfirm = (bar.volume ?? 0) > avgVol * 1.0;

    // 停損停利檢查
    if (this._position !== 0 && this._entryPrice > 0) {
      const pnlPct =
        this._position > 0
          ? ((curr - this._entryPrice) / this._entryPrice) * 100
          : ((this._entryPrice - curr) / this._entryPrice) * 100;

      if (pnlPct <= -this.stopLoss) {
        const dir = this._position > 0 ? "close_long" : "close_short";
        this.signal(dir, `停損觸發 ${pnlPct.toFixed(2)}%`, this.maxQty);
        this._position = 0;
        this._entryPrice = 0;
        return;
      }
      if (pnlPct >= this.takeProfit) {
        const dir = this._position > 0 ? "close_long" : "close_short";
        this.signal(dir, `停利觸發 ${pnlPct.toFixed(2)}%`, this.maxQty);
        this._position = 0;
        this._entryPrice = 0;
        return;
      }
    }

    // 多頭訊號：價格從下方穿越 SMA 且動量超過門檻 + 量確認
    if (momentum > this.threshold && volConfirm && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `動量反轉向上 ${momentum.toFixed(2)}%`, this.maxQty);
      }
      this.signal("buy", `動量突破 SMA${this.period} (${momentum.toFixed(2)}%)`, this.maxQty);
      this._position = 1;
      this._entryPrice = curr;
    }
    // 空頭訊號：動量翻負且跌破 SMA
    else if (momentum < -this.threshold && volConfirm && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `動量反轉向下 ${momentum.toFixed(2)}%`, this.maxQty);
      }
      this.signal("sell", `動量跌破 SMA${this.period} (${momentum.toFixed(2)}%)`, this.maxQty);
      this._position = -1;
      this._entryPrice = curr;
    }
  }

  /** 計算簡單移動平均 */
  _sma(arr, n) {
    const slice = arr.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
}

export default MomentumStrategy;
