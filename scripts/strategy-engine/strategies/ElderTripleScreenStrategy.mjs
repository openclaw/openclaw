import { MACD, Stochastic } from "technicalindicators";
// ElderTripleScreenStrategy.mjs — Elder 三螢幕交易系統
// 移植自 Alexander Elder《以交易為生》三螢幕系統 MT4 EA
// 開源參考：https://www.mql5.com/en/code/9913
//
// 第一螢幕（週線趨勢）：MACD 柱狀圖方向
// 第二螢幕（日線時機）：Stochastic 超買超賣
// 第三螢幕（進場）：在趨勢方向的當日突破（簡化為最新 K 棒收盤確認）
//
// 由於策略引擎只有單一時間框架，本實作用長短期 EMA 比例模擬多時框
import { BaseStrategy } from "../BaseStrategy.mjs";

export class ElderTripleScreenStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    // 第一螢幕：MACD 週期（模擬週線趨勢用較長週期）
    this.macdFast = this.params.macdFast ?? 26;
    this.macdSlow = this.params.macdSlow ?? 52;
    this.macdSignal = this.params.macdSignal ?? 18;
    // 第二螢幕：Stochastic 日線時機
    this.stochPeriod = this.params.stochPeriod ?? 5;
    this.stochD = this.params.stochD ?? 3;
    this.oversold = this.params.oversold ?? 30;
    this.overbought = this.params.overbought ?? 70;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const minBars = this.macdSlow + this.macdSignal + 5;
    if (this.barCount() < minBars) {
      return;
    }

    // 第一螢幕：MACD 柱狀圖
    const macdRes = MACD.calculate({
      values: this.closes(),
      fastPeriod: this.macdFast,
      slowPeriod: this.macdSlow,
      signalPeriod: this.macdSignal,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (macdRes.length < 2) {
      return;
    }
    const macdLast = macdRes[macdRes.length - 1];
    if (macdLast.histogram == null) {
      return;
    }
    const trendUp = macdLast.histogram > 0;

    // 第二螢幕：Stochastic
    const stochRes = Stochastic.calculate({
      period: this.stochPeriod,
      signalPeriod: this.stochD,
      high: this.highs(),
      low: this.lows(),
      close: this.closes(),
    });
    if (stochRes.length < 2) {
      return;
    }
    const stochCurr = stochRes[stochRes.length - 1];
    const stochPrev = stochRes[stochRes.length - 2];

    // 做多信號：週線 MACD 多頭 + 日線 Stochastic 從超賣回升
    if (
      trendUp &&
      stochPrev.k <= this.oversold &&
      stochCurr.k > this.oversold &&
      this._position !== 1
    ) {
      if (this._position === -1) {
        this.signal("close_short", "Elder 三螢幕翻多平空", this.maxQty);
      }
      this.signal(
        "buy",
        `Elder Screen: MACD hist=${macdLast.histogram.toFixed(3)} K=${stochCurr.k.toFixed(1)} 超賣回升`,
        this.maxQty,
      );
      this._position = 1;
    }
    // 做空信號：週線 MACD 空頭 + 日線 Stochastic 從超買回落
    else if (
      !trendUp &&
      stochPrev.k >= this.overbought &&
      stochCurr.k < this.overbought &&
      this._position !== -1
    ) {
      if (this._position === 1) {
        this.signal("close_long", "Elder 三螢幕翻空平多", this.maxQty);
      }
      this.signal(
        "sell",
        `Elder Screen: MACD hist=${macdLast.histogram.toFixed(3)} K=${stochCurr.k.toFixed(1)} 超買回落`,
        this.maxQty,
      );
      this._position = -1;
    }
  }
}
