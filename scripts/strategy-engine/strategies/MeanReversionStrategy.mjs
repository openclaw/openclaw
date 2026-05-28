// MeanReversionStrategy.mjs — 均值回歸策略（布林通道風格）
// 價格偏離均線超過 N 倍標準差時逆勢交易
import { BaseStrategy } from "../BaseStrategy.mjs";

export class MeanReversionStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 20;
    this.stdDevMult = this.params.stdDev ?? this.params.zScore ?? 2.0; // 標準差倍數
    this.stopLoss = this.params.stopLoss ?? 3.0; // 停損百分比
    this.takeProfit = this.params.takeProfit ?? 2.0; // 停利百分比
    this._entryPrice = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const closes = this.closes();
    const curr = bar.close;

    // 計算布林通道
    const sma = this._sma(closes, this.period);
    const stdDev = this._stdDev(closes, this.period);
    const upperBand = sma + this.stdDevMult * stdDev;
    const lowerBand = sma - this.stdDevMult * stdDev;

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

    // 回歸中軌出場
    if (this._position === 1 && curr >= sma) {
      this.signal("close_long", `價格回歸均線 ${sma.toFixed(2)}`, this.maxQty);
      this._position = 0;
      this._entryPrice = 0;
      return;
    }
    if (this._position === -1 && curr <= sma) {
      this.signal("close_short", `價格回歸均線 ${sma.toFixed(2)}`, this.maxQty);
      this._position = 0;
      this._entryPrice = 0;
      return;
    }

    // 買入訊號：價格跌破下軌（超賣）
    if (curr < lowerBand && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", `下軌反彈`, this.maxQty);
      }
      this.signal(
        "buy",
        `超賣: 價格 ${curr.toFixed(2)} < 下軌 ${lowerBand.toFixed(2)}`,
        this.maxQty,
      );
      this._position = 1;
      this._entryPrice = curr;
    }
    // 賣出訊號：價格突破上軌（超買）
    else if (curr > upperBand && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", `上軌反壓`, this.maxQty);
      }
      this.signal(
        "sell",
        `超買: 價格 ${curr.toFixed(2)} > 上軌 ${upperBand.toFixed(2)}`,
        this.maxQty,
      );
      this._position = -1;
      this._entryPrice = curr;
    }
  }

  /** 計算簡單移動平均 */
  _sma(arr, n) {
    const slice = arr.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /** 計算標準差 */
  _stdDev(arr, n) {
    const slice = arr.slice(-n);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance);
  }
}

export default MeanReversionStrategy;
