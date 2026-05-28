import { BollingerBands } from "technicalindicators";
// BollingerBandStrategy.mjs — 布林通道均值回歸 + 突破策略
// 移植自 crypto-trading-bot / TradingView BB 策略
import { BaseStrategy } from "../BaseStrategy.mjs";

export class BollingerBandStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.period = this.params.period ?? 20;
    this.stdDev = this.params.stdDev ?? 2;
    // mode: "revert"=均值回歸, "breakout"=突破
    this.mode = this.params.mode ?? "revert";
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.period + 1) {
      return;
    }

    const results = BollingerBands.calculate({
      period: this.period,
      stdDev: this.stdDev,
      values: this.closes(),
    });
    if (results.length < 2) {
      return;
    }

    const curr = results[results.length - 1];
    const prev = results[results.length - 2];
    const close = this.closes()[this.closes().length - 1];
    const pClose = this.closes()[this.closes().length - 2];

    if (this.mode === "revert") {
      // 均值回歸：觸碰下軌後回升 → 買；觸碰上軌後回落 → 賣
      if (pClose <= prev.lower && close > curr.lower && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", "BB 下軌反彈", this.maxQty);
        }
        this.signal(
          "buy",
          `BB 下軌=${curr.lower.toFixed(2)} 反彈 中軌=${curr.middle.toFixed(2)}`,
          this.maxQty,
        );
        this._position = 1;
      } else if (pClose >= prev.upper && close < curr.upper && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", "BB 上軌回落", this.maxQty);
        }
        this.signal(
          "sell",
          `BB 上軌=${curr.upper.toFixed(2)} 回落 中軌=${curr.middle.toFixed(2)}`,
          this.maxQty,
        );
        this._position = -1;
      }
    } else {
      // 突破模式：收盤突破上軌 → 買；跌破下軌 → 賣
      if (pClose <= prev.upper && close > curr.upper && this._position !== 1) {
        if (this._position === -1) {
          this.signal("close_short", "BB 向上突破", this.maxQty);
        }
        this.signal("buy", `BB 上軌突破 ${curr.upper.toFixed(2)}`, this.maxQty);
        this._position = 1;
      } else if (pClose >= prev.lower && close < curr.lower && this._position !== -1) {
        if (this._position === 1) {
          this.signal("close_long", "BB 向下突破", this.maxQty);
        }
        this.signal("sell", `BB 下軌跌破 ${curr.lower.toFixed(2)}`, this.maxQty);
        this._position = -1;
      }
    }
  }
}
