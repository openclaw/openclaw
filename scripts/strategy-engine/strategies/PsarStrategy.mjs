import { PSAR } from "technicalindicators";
// PsarStrategy.mjs — 拋物線 SAR 趨勢跟蹤策略
// 移植自 MT4 Parabolic SAR EA / Haehnchen crypto-trading-bot PSAR 策略
import { BaseStrategy } from "../BaseStrategy.mjs";

export class PsarStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.step = this.params.step ?? 0.02;
    this.max = this.params.max ?? 0.2;
    this._prevSar = null;
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < 3) {
      return;
    }

    const highs = this.highs();
    const lows = this.lows();
    const closes = this.closes();

    const results = PSAR.calculate({ step: this.step, max: this.max, high: highs, low: lows });
    if (results.length < 2) {
      return;
    }

    const sar = results[results.length - 1];
    const prevSar = results[results.length - 2];
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    // 方向判斷：SAR 在價格下方 = 多頭；SAR 在價格上方 = 空頭
    const bullish = sar < lastClose;
    const prevBullish = prevSar < prevClose;

    if (!prevBullish && bullish && this._position !== 1) {
      if (this._position === -1) {
        this.signal("close_short", "PSAR 翻多", this.maxQty);
      }
      this.signal("buy", `PSAR=${sar.toFixed(2)} 轉至價格下方`, this.maxQty);
      this._position = 1;
    } else if (prevBullish && !bullish && this._position !== -1) {
      if (this._position === 1) {
        this.signal("close_long", "PSAR 翻空", this.maxQty);
      }
      this.signal("sell", `PSAR=${sar.toFixed(2)} 轉至價格上方`, this.maxQty);
      this._position = -1;
    }
  }
}
