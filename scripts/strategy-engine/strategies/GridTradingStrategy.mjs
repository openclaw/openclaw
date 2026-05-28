import { ATR } from "technicalindicators";
// GridTradingStrategy.mjs — 智慧網格交易策略
// 移植自 Pionex / Binance Grid Bot / Hummingbot Pure Market Making
// 開源：https://github.com/hummingbot/hummingbot/tree/master/hummingbot/strategy/pure_market_making
//
// 三種模式：
//   等距網格 (arithmetic)  — 固定金額間距，震盪市適用
//   等比網格 (geometric)   — 固定比例間距，趨勢市適用
//   智慧網格 (smart)       — ATR 動態調整間距
//
// 邏輯：在上下各 gridCount 個價位掛好買賣單
//   有單成交 → 立即在另一側補單
//   整個網格移動（追蹤中間價）
import { BaseStrategy } from "../BaseStrategy.mjs";

export class GridTradingStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    this.mode = this.params.mode ?? "arithmetic"; // arithmetic | geometric | smart
    this.gridCount = this.params.gridCount ?? 5; // 單側格數
    this.gridSpacing = this.params.gridSpacing ?? 10; // 等距模式：每格點數
    this.gridPct = this.params.gridPct ?? 0.005; // 等比模式：每格比例
    this.upperLimit = this.params.upperLimit ?? null; // 網格上界（null=自動）
    this.lowerLimit = this.params.lowerLimit ?? null; // 網格下界（null=自動）
    this.atrPeriod = this.params.atrPeriod ?? 14;
    this.atrMult = this.params.atrMult ?? 0.5; // 智慧網格：格距=ATR×0.5
    this.rebalanceN = this.params.rebalanceN ?? 20; // 每 N 根K棒重建網格

    this._grid = []; // 網格價位陣列（由低到高）
    this._orders = {}; // price → 'buy' | 'sell' | 'filled'
    this._barsSinceGrid = 0;
    this._position = 0;
    this._gridCenter = null;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.atrPeriod + 2) {
      return;
    }

    this._barsSinceGrid++;
    const price = bar.close;

    // 建立/重建網格
    if (!this._grid.length || this._barsSinceGrid >= this.rebalanceN) {
      this._buildGrid(price);
      this._barsSinceGrid = 0;
    }

    // 掃描成交（簡化：收盤穿越某格位則視為成交）
    for (const level of this._grid) {
      const order = this._orders[level];
      if (!order || order === "filled") {
        continue;
      }

      if (order === "buy" && bar.low <= level && level <= bar.high) {
        // 買單成交 → 在上方一格掛賣單
        this._fill("buy", level, bar.time);
      } else if (order === "sell" && bar.low <= level && level <= bar.high) {
        // 賣單成交 → 在下方一格掛買單
        this._fill("sell", level, bar.time);
      }
    }
  }

  _buildGrid(centerPrice) {
    this._gridCenter = centerPrice;
    this._grid = [];
    this._orders = {};

    const spacing = this._calcSpacing(centerPrice);

    const upper = this.upperLimit ?? centerPrice + spacing * this.gridCount;
    const lower = this.lowerLimit ?? centerPrice - spacing * this.gridCount;

    if (this.mode === "geometric") {
      for (let i = -this.gridCount; i <= this.gridCount; i++) {
        const level = centerPrice * (1 + this.gridPct) ** i;
        if (level >= lower && level <= upper) {
          this._grid.push(+level.toFixed(2));
        }
      }
    } else {
      for (let i = -this.gridCount; i <= this.gridCount; i++) {
        const level = centerPrice + i * spacing;
        if (level >= lower && level <= upper) {
          this._grid.push(+level.toFixed(2));
        }
      }
    }
    this._grid.sort((a, b) => a - b);

    // 中心價以下掛買單，以上掛賣單
    for (const level of this._grid) {
      if (level < centerPrice) {
        this._orders[level] = "buy";
      } else if (level > centerPrice) {
        this._orders[level] = "sell";
      }
    }
  }

  _calcSpacing(_price) {
    if (this.mode === "smart") {
      const atrVals = ATR.calculate({
        period: this.atrPeriod,
        high: this.highs(),
        low: this.lows(),
        close: this.closes(),
      });
      const atr = atrVals[atrVals.length - 1] ?? this.gridSpacing;
      return atr * this.atrMult;
    }
    return this.gridSpacing;
  }

  _fill(filledSide, level, _time) {
    this._orders[level] = "filled";
    const idx = this._grid.indexOf(level);
    const spacing = this._calcSpacing(level);

    if (filledSide === "buy") {
      // 買單成交 → 部位 +1，在上方掛賣單
      this._position++;
      this.signal("buy", `網格買入 @${level} (格${idx})`, 1);
      const sellLevel = +(level + spacing).toFixed(2);
      if (!this._orders[sellLevel]) {
        this._grid.push(sellLevel);
        this._grid.sort((a, b) => a - b);
        this._orders[sellLevel] = "sell";
      }
    } else {
      // 賣單成交 → 部位 -1，在下方掛買單
      this._position--;
      this.signal("close_long", `網格賣出 @${level} (格${idx})`, 1);
      const buyLevel = +(level - spacing).toFixed(2);
      if (!this._orders[buyLevel]) {
        this._grid.push(buyLevel);
        this._grid.sort((a, b) => a - b);
        this._orders[buyLevel] = "buy";
      }
    }
  }

  getGridStatus() {
    return {
      center: this._gridCenter,
      levels: this._grid.length,
      orders: this._orders,
      position: this._position,
    };
  }
}
