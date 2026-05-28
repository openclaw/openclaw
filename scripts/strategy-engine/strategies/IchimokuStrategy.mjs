import { IchimokuCloud } from "technicalindicators";
// IchimokuStrategy.mjs — 一目均衡表雲層突破策略
// 移植自 TradingView Ichimoku EA 核心邏輯
import { BaseStrategy } from "../BaseStrategy.mjs";

export class IchimokuStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.conversionPeriod = this.params.conversion ?? 9; // 轉換線 (Tenkan-sen)
    this.basePeriod = this.params.base ?? 26; // 基準線 (Kijun-sen)
    this.spanPeriod = this.params.span ?? 52; // 先行帶 B (Senkou Span B)
    this.displacement = this.params.displacement ?? 26; // 位移
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const minBars = this.spanPeriod + this.displacement + 1;
    if (this.barCount() < minBars) {
      return;
    }

    const results = IchimokuCloud.calculate({
      conversionPeriod: this.conversionPeriod,
      basePeriod: this.basePeriod,
      spanPeriod: this.spanPeriod,
      displacement: this.displacement,
      high: this.highs(),
      low: this.lows(),
    });
    if (results.length < 2) {
      return;
    }

    const curr = results[results.length - 1];
    const prev = results[results.length - 2];
    const lastClose = this.closes()[this.closes().length - 1];

    // 雲層上下邊界
    const cloudTop = Math.max(curr.spanA, curr.spanB);
    const cloudBottom = Math.min(curr.spanA, curr.spanB);

    // TK Cross: 轉換線向上穿越基準線，且價格在雲層上方 → 多
    const tkBullish = curr.conversion > curr.base;
    const tkPrevBullish = prev.conversion > prev.base;
    const aboveCloud = lastClose > cloudTop;
    const belowCloud = lastClose < cloudBottom;

    if (!tkPrevBullish && tkBullish && aboveCloud && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", "Ichimoku TK 黃金交叉", this.maxQty);
      }
      this.signal(
        "buy",
        `Tenkan(${curr.conversion.toFixed(2)}) ↑ Kijun(${curr.base.toFixed(2)}) 雲層上方`,
        this.maxQty,
      );
      this._position = 1;
    } else if (tkPrevBullish && !tkBullish && belowCloud && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", "Ichimoku TK 死亡交叉", this.maxQty);
      }
      this.signal(
        "sell",
        `Tenkan(${curr.conversion.toFixed(2)}) ↓ Kijun(${curr.base.toFixed(2)}) 雲層下方`,
        this.maxQty,
      );
      this._position = -1;
    }
  }
}
