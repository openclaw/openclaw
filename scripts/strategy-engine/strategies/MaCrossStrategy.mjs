import { EMA, CrossUp, CrossDown } from "technicalindicators";
// MaCrossStrategy.mjs — 均線交叉策略 (移植自 MT4 Moving Average EA)
// 使用 technicalindicators 套件的 EMA + CrossUp/CrossDown
import { BaseStrategy } from "../BaseStrategy.mjs";

export class MaCrossStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.fast = this.params.fast ?? 5;
    this.slow = this.params.slow ?? 20;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.slow + 2) {
      return;
    }
    const closes = this.closes();

    const fastVals = EMA.calculate({ period: this.fast, values: closes });
    const slowVals = EMA.calculate({ period: this.slow, values: closes });
    if (fastVals.length < 2 || slowVals.length < 2) {
      return;
    }

    // 對齊長度
    const len = Math.min(fastVals.length, slowVals.length);
    const fSlice = fastVals.slice(-len);
    const sSlice = slowVals.slice(-len);

    const crossUp = CrossUp.calculate({ lineA: fSlice, lineB: sSlice });
    const crossDown = CrossDown.calculate({ lineA: fSlice, lineB: sSlice });

    const lastFast = fSlice[fSlice.length - 1];
    const lastSlow = sSlice[sSlice.length - 1];

    if (crossUp[crossUp.length - 1] && !this.isLong()) {
      if (this.isShort()) {
        this.signal("close_short", `EMA${this.fast} 向上穿越 EMA${this.slow}`);
      }
      this.signal(
        "buy",
        `EMA${this.fast}(${lastFast.toFixed(2)}) ↑ EMA${this.slow}(${lastSlow.toFixed(2)})`,
      );
      this._position = 1;
    } else if (crossDown[crossDown.length - 1] && !this.isShort()) {
      if (this.isLong()) {
        this.signal("close_long", `EMA${this.fast} 向下穿越 EMA${this.slow}`);
      }
      this.signal(
        "sell",
        `EMA${this.fast}(${lastFast.toFixed(2)}) ↓ EMA${this.slow}(${lastSlow.toFixed(2)})`,
      );
      this._position = -1;
    }
  }
}
