// ThreeBarReversalStrategy.mjs — 三根 K 棒反轉型態策略
// 移植自 MT4 Three Bar Reversal / Inside Bar EA
// 開源參考：https://github.com/nicholashogle/MT4-Expert-Advisors
// 型態：
//   多頭反轉：前第2根為大跌棒，前1根為小範圍棒 (Inside Bar)，最新棒突破前2棒高點
//   空頭反轉：前第2根為大漲棒，前1根為小範圍棒 (Inside Bar)，最新棒跌破前2棒低點
import { BaseStrategy } from "../BaseStrategy.mjs";

export class ThreeBarReversalStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // minBodyRatio: 「大棒」需要的實體占比（佔整體波幅）
    this.minBodyRatio = this.params.minBodyRatio ?? 0.6;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < 3) {
      return;
    }

    const hist = this._priceHistory;
    const n = hist.length;
    const b0 = hist[n - 1]; // 最新棒
    const b1 = hist[n - 2]; // 前1棒 (Inside Bar 候選)
    const b2 = hist[n - 3]; // 前2棒 (信號棒)

    const b2Range = b2.high - b2.low;
    if (b2Range <= 0) {
      return;
    }
    const b2Body = Math.abs(b2.close - b2.open);

    // b1 必須是 Inside Bar（高低點在 b2 範圍內）
    const isInsideBar = b1.high <= b2.high && b1.low >= b2.low;
    if (!isInsideBar) {
      return;
    }

    // b2 是大棒
    const isBigBar = b2Body / b2Range >= this.minBodyRatio;
    if (!isBigBar) {
      return;
    }

    const b2Bearish = b2.close < b2.open; // 大跌棒 → 多頭反轉
    const b2Bullish = b2.close > b2.open; // 大漲棒 → 空頭反轉

    // 多頭反轉：大跌棒 + Inside Bar + 突破 b2 高點
    if (b2Bearish && b0.close > b2.high && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", "三K棒多頭反轉平空", this.maxQty);
      }
      this.signal(
        "buy",
        `三K棒多頭反轉 突破=${b2.high.toFixed(2)} 信號棒跌幅=${(((b2.open - b2.close) / b2.open) * 100).toFixed(1)}%`,
        this.maxQty,
      );
      this._position = 1;
    }
    // 空頭反轉：大漲棒 + Inside Bar + 跌破 b2 低點
    else if (b2Bullish && b0.close < b2.low && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", "三K棒空頭反轉平多", this.maxQty);
      }
      this.signal(
        "sell",
        `三K棒空頭反轉 跌破=${b2.low.toFixed(2)} 信號棒漲幅=${(((b2.close - b2.open) / b2.open) * 100).toFixed(1)}%`,
        this.maxQty,
      );
      this._position = -1;
    }
  }
}
