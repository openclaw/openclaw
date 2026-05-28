import { RSI, MACD } from "technicalindicators";
// DivergenceStrategy.mjs — RSI / MACD 背離偵測策略
// 移植自 TradingView Divergence Indicator / freqtrade divergence strategy
// 開源：https://github.com/nickvdyck/trading-divergence
//
// 背離類型：
//   常規看漲背離 (Regular Bullish)：價格創新低，RSI 未創新低 → 反轉向上
//   常規看跌背離 (Regular Bearish)：價格創新高，RSI 未創新高 → 反轉向下
//   隱藏看漲背離 (Hidden Bullish)： 價格未創新低，RSI 創新低   → 趨勢延續向上
//   隱藏看跌背離 (Hidden Bearish)： 價格未創新高，RSI 創新高   → 趨勢延續向下
import { BaseStrategy } from "../BaseStrategy.mjs";

function findPivotHighIdx(arr, i, left, right) {
  if (i < left || i + right >= arr.length) {
    return false;
  }
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && arr[j] >= arr[i]) {
      return false;
    }
  }
  return true;
}
function findPivotLowIdx(arr, i, left, right) {
  if (i < left || i + right >= arr.length) {
    return false;
  }
  for (let j = i - left; j <= i + right; j++) {
    if (j !== i && arr[j] <= arr[i]) {
      return false;
    }
  }
  return true;
}

export class DivergenceStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.indicator = this.params.indicator ?? "rsi"; // 'rsi' | 'macd'
    this.rsiPeriod = this.params.rsiPeriod ?? 14;
    this.leftBars = this.params.leftBars ?? 5;
    this.rightBars = this.params.rightBars ?? 5;
    this.lookback = this.params.lookback ?? 50; // 最多往前找幾根
    this.hiddenDiv = this.params.hiddenDiv ?? false; // 是否偵測隱藏背離
    this._position = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    const minBars = this.rsiPeriod + this.leftBars + this.rightBars + 3;
    if (this.barCount() < minBars) {
      return;
    }

    const closes = this.closes();
    const n = closes.length;

    // 計算指標序列
    let indicatorVals;
    if (this.indicator === "rsi") {
      indicatorVals = RSI.calculate({ period: this.rsiPeriod, values: closes });
    } else {
      const macdRes = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      indicatorVals = macdRes.map((m) => m.histogram ?? 0);
    }

    const offset = n - indicatorVals.length;
    const checkIdx = indicatorVals.length - 1 - this.rightBars;
    if (checkIdx < this.leftBars) {
      return;
    }

    const priceAtCheck = closes[checkIdx + offset];
    const indAtCheck = indicatorVals[checkIdx];

    // 找前一個 Pivot 點（lookback 根前）
    const start = Math.max(0, checkIdx - this.lookback);
    let prevHighIdx = -1,
      prevLowIdx = -1;
    for (let i = start; i < checkIdx - this.rightBars; i++) {
      if (findPivotHighIdx(closes.slice(offset), i, this.leftBars, this.rightBars)) {
        prevHighIdx = i;
      }
      if (findPivotLowIdx(closes.slice(offset), i, this.leftBars, this.rightBars)) {
        prevLowIdx = i;
      }
    }

    // ── 看跌背離：價格創新高，指標未創新高 ──
    if (prevHighIdx >= 0) {
      const prevPrice = closes[prevHighIdx + offset];
      const prevInd = indicatorVals[prevHighIdx];

      if (priceAtCheck > prevPrice && indAtCheck < prevInd && this._position !== -1) {
        // 常規看跌背離
        if (this._position === 1) {
          this.signal("close_long", `看跌背離平多`, this.maxQty);
        }
        this.signal(
          "sell",
          `📉 看跌背離(${this.indicator.toUpperCase()}) 價格${prevPrice.toFixed(0)}→${priceAtCheck.toFixed(0)} 指標${prevInd.toFixed(1)}→${indAtCheck.toFixed(1)}`,
          this.maxQty,
        );
        this._position = -1;
      } else if (
        this.hiddenDiv &&
        priceAtCheck < prevPrice &&
        indAtCheck > prevInd &&
        this._position !== -1
      ) {
        // 隱藏看跌背離（趨勢延續向下）
        if (this._position === 1) {
          this.signal("close_long", `隱藏看跌背離平多`, this.maxQty);
        }
        this.signal(
          "sell",
          `📉 隱藏看跌背離(${this.indicator.toUpperCase()}) 趨勢延續`,
          this.maxQty,
        );
        this._position = -1;
      }
    }

    // ── 看漲背離：價格創新低，指標未創新低 ──
    if (prevLowIdx >= 0) {
      const prevPrice = closes[prevLowIdx + offset];
      const prevInd = indicatorVals[prevLowIdx];

      if (priceAtCheck < prevPrice && indAtCheck > prevInd && this._position !== 1) {
        // 常規看漲背離
        if (this._position === -1) {
          this.signal("close_short", `看漲背離平空`, this.maxQty);
        }
        this.signal(
          "buy",
          `📈 看漲背離(${this.indicator.toUpperCase()}) 價格${prevPrice.toFixed(0)}→${priceAtCheck.toFixed(0)} 指標${prevInd.toFixed(1)}→${indAtCheck.toFixed(1)}`,
          this.maxQty,
        );
        this._position = 1;
      } else if (
        this.hiddenDiv &&
        priceAtCheck > prevPrice &&
        indAtCheck < prevInd &&
        this._position !== 1
      ) {
        // 隱藏看漲背離（趨勢延續向上）
        if (this._position === -1) {
          this.signal("close_short", `隱藏看漲背離平空`, this.maxQty);
        }
        this.signal(
          "buy",
          `📈 隱藏看漲背離(${this.indicator.toUpperCase()}) 趨勢延續`,
          this.maxQty,
        );
        this._position = 1;
      }
    }
  }
}
