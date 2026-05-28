// OverseasFuturesStrategies.mjs — 海外期貨專屬策略
//
// 1. OpeningRangeBreakout (ORB)  — 美股/ES/NQ 開盤區間突破
// 2. VixMeanReversion            — VIX 均值回歸（逆向操作 ES）
// 3. CommoditySeasonality        — 原油/黃金季節性策略
// 4. GlobalMomentum              — 跨市場動能輪動（ES/NQ/GC/CL）
// 5. OvernightGapFade            — 隔夜跳空回補（亞盤補差）

import { BaseStrategy } from "../BaseStrategy.mjs";
import { getSpec } from "../brokers/ContractSpecs.mjs";

// ── 工具函數 ─────────────────────────────────────────────────────
function sma(arr, n) {
  if (arr.length < n) {
    return null;
  }
  return arr.slice(-n).reduce((s, v) => s + v, 0) / n;
}
function atr(bars, n = 14) {
  if (bars.length < n + 1) {
    return null;
  }
  const trs = bars
    .slice(-n - 1)
    .slice(1)
    .map((b, i) => {
      const prev = bars[bars.length - n - 1 + i];
      return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    });
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

// ══════════════════════════════════════════════════════════════════
// 1. Opening Range Breakout (ORB)
// ══════════════════════════════════════════════════════════════════
/**
 * 開盤 N 分鐘區間突破策略
 * - 最適用：ES、NQ（美股開盤 21:30 台灣時間）
 * - 原理：開盤後 N 根 K 棒定義「開盤區間」High/Low，
 *         收盤突破 High → 做多；跌破 Low → 做空
 * - 只交易每日美股正規交易時段（21:30-04:00 台灣時間）
 */
export class OpeningRangeBreakoutStrategy extends BaseStrategy {
  /**
   * @param {object} opts
   * @param {number} opts.params.orbBars      開盤區間 K 棒數（預設 6，即前 30 分鐘 on 5min）
   * @param {number} opts.params.atrMultiple  突破確認：價格超出區間至少 ATR * X（預設 0.2）
   * @param {number} opts.params.atrPeriod    ATR 週期（預設 14）
   * @param {number} opts.params.rrRatio      風報比（預設 2）
   * @param {string} opts.params.sessionOpen  開盤時間（'21:30'，24h 台灣時間，預設美股）
   */
  constructor(opts = {}) {
    super(opts);
    this.orbBars = this.params.orbBars ?? 6;
    this.atrMultiple = this.params.atrMultiple ?? 0.2;
    this.atrPeriod = this.params.atrPeriod ?? 14;
    this.rrRatio = this.params.rrRatio ?? 2;
    this.sessionOpen = this.params.sessionOpen ?? "21:30"; // 台灣時間

    this._orbHigh = null;
    this._orbLow = null;
    this._orbSet = false;
    this._todayBars = 0;
    this._lastDate = "";
    this._position = 0;
    this._entryPrice = 0;
    this._stopPrice = 0;
    this._tpPrice = 0;
    this._spec = getSpec(this.instrument.replace(/[0-9]/g, ""));
  }

  onBar(bar) {
    this.addBar(bar);

    const barDate = bar.time?.slice(0, 10) ?? "";
    const barTime = bar.time?.slice(11, 16) ?? "";

    // 新的一天，重置
    if (barDate !== this._lastDate) {
      this._lastDate = barDate;
      this._todayBars = 0;
      this._orbHigh = null;
      this._orbLow = null;
      this._orbSet = false;
    }
    this._todayBars++;

    const isInSession = barTime >= this.sessionOpen;
    if (!isInSession) {
      return;
    }

    // 建立開盤區間（前 orbBars 根 K 棒）
    if (!this._orbSet) {
      if (this._todayBars <= this.orbBars) {
        if (this._orbHigh === null) {
          this._orbHigh = bar.high;
        }
        if (this._orbLow === null) {
          this._orbLow = bar.low;
        }
        this._orbHigh = Math.max(this._orbHigh, bar.high);
        this._orbLow = Math.min(this._orbLow, bar.low);
      } else {
        this._orbSet = true;
      }
      return;
    }

    const curAtr = atr(this._priceHistory, this.atrPeriod) ?? this._orbHigh - this._orbLow;
    const minMove = curAtr * this.atrMultiple;

    // 止損/止盈監控（已持倉）
    if (this._position !== 0) {
      if (this._position > 0) {
        if (bar.low <= this._stopPrice) {
          this.signal("close_long", `ORB 止損 low=${bar.low} ≤ stop=${this._stopPrice.toFixed(2)}`);
          this._position = 0;
        } else if (bar.high >= this._tpPrice) {
          this.signal("close_long", `ORB 止盈 high=${bar.high} ≥ tp=${this._tpPrice.toFixed(2)}`);
          this._position = 0;
        }
      } else {
        if (bar.high >= this._stopPrice) {
          this.signal(
            "close_short",
            `ORB 止損 high=${bar.high} ≥ stop=${this._stopPrice.toFixed(2)}`,
          );
          this._position = 0;
        } else if (bar.low <= this._tpPrice) {
          this.signal("close_short", `ORB 止盈 low=${bar.low} ≤ tp=${this._tpPrice.toFixed(2)}`);
          this._position = 0;
        }
      }
      return;
    }

    // 突破做多
    if (bar.close > this._orbHigh + minMove) {
      const rng = this._orbHigh - this._orbLow;
      this._stopPrice = this._orbLow;
      this._tpPrice = this._orbHigh + rng * this.rrRatio;
      this._entryPrice = bar.close;
      this._position = 1;
      this.signal(
        "buy",
        `ORB 突破 close=${bar.close} > high=${this._orbHigh.toFixed(2)} TP=${this._tpPrice.toFixed(2)} SL=${this._stopPrice.toFixed(2)}`,
      );
    }
    // 跌破做空
    else if (bar.close < this._orbLow - minMove) {
      const rng = this._orbHigh - this._orbLow;
      this._stopPrice = this._orbHigh;
      this._tpPrice = this._orbLow - rng * this.rrRatio;
      this._entryPrice = bar.close;
      this._position = -1;
      this.signal(
        "sell",
        `ORB 跌破 close=${bar.close} < low=${this._orbLow.toFixed(2)} TP=${this._tpPrice.toFixed(2)} SL=${this._stopPrice.toFixed(2)}`,
      );
    }
  }

  status() {
    return {
      orbHigh: this._orbHigh,
      orbLow: this._orbLow,
      orbSet: this._orbSet,
      position: this._position,
      stopPrice: this._stopPrice,
      tpPrice: this._tpPrice,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// 2. VIX Mean Reversion Strategy
// ══════════════════════════════════════════════════════════════════
/**
 * 利用 VIX 均值回歸做 ES 逆向操作
 * - VIX > vixHigh (恐慌) → ES 做多（賭回彈）
 * - VIX < vixLow  (低波) → ES 做空（賭修正）
 * - 需要同時接收 VIX 和 ES 的行情
 */
export class VixMeanReversionStrategy extends BaseStrategy {
  /**
   * @param {object} opts
   * @param {number} opts.params.vixHigh       VIX 高位閾值（預設 25，觸發做多 ES）
   * @param {number} opts.params.vixLow        VIX 低位閾值（預設 12，觸發做空 ES）
   * @param {number} opts.params.vixSmaPeriod  VIX 均線週期（預設 20）
   * @param {number} opts.params.holdBars      持倉 K 棒數（預設 5）
   * @param {number} opts.params.atrStop       ATR 倍數止損（預設 1.5）
   */
  constructor(opts = {}) {
    super(opts);
    this.vixHigh = this.params.vixHigh ?? 25;
    this.vixLow = this.params.vixLow ?? 12;
    this.vixSmaPeriod = this.params.vixSmaPeriod ?? 20;
    this.holdBars = this.params.holdBars ?? 5;
    this.atrStop = this.params.atrStop ?? 1.5;

    this._vixHistory = []; // 儲存 VIX 歷史
    this._heldBars = 0;
    this._stopPrice = 0;
    this._position = 0;
  }

  /** 從外部推入 VIX 數值（每根 K 棒同步呼叫） */
  updateVix(vixValue) {
    this._vixHistory.push(vixValue);
    if (this._vixHistory.length > 100) {
      this._vixHistory.shift();
    }
  }

  onBar(bar) {
    this.addBar(bar);
    if (this._vixHistory.length < this.vixSmaPeriod + 1) {
      return;
    }

    const curVix = this._vixHistory[this._vixHistory.length - 1];
    const vixSma = sma(this._vixHistory, this.vixSmaPeriod);
    const curAtr = atr(this._priceHistory, 14) ?? bar.high - bar.low;
    const vixSpike = curVix - vixSma;

    // 持倉中：計算持倉時間 + 止損
    if (this._position !== 0) {
      this._heldBars++;
      if (this._position > 0) {
        if (bar.low <= this._stopPrice || this._heldBars >= this.holdBars) {
          const reason =
            bar.low <= this._stopPrice
              ? `VIX 止損 low=${bar.low} ≤ ${this._stopPrice.toFixed(1)}`
              : `VIX 持倉到期 ${this._heldBars} 根`;
          this.signal("close_long", reason);
          this._position = 0;
        }
      } else {
        if (bar.high >= this._stopPrice || this._heldBars >= this.holdBars) {
          const reason =
            bar.high >= this._stopPrice
              ? `VIX 止損 high=${bar.high} ≥ ${this._stopPrice.toFixed(1)}`
              : `VIX 持倉到期 ${this._heldBars} 根`;
          this.signal("close_short", reason);
          this._position = 0;
        }
      }
      return;
    }

    // 進場：VIX 高位（恐慌）→ 做多 ES（反向）
    if (curVix > this.vixHigh && vixSpike > 0) {
      this._stopPrice = bar.close - curAtr * this.atrStop;
      this._position = 1;
      this._heldBars = 0;
      this.signal(
        "buy",
        `VIX=${curVix.toFixed(1)} > ${this.vixHigh}（恐慌進場做多）SMA=${vixSma.toFixed(1)}`,
      );
    }
    // 進場：VIX 低位（低波動）→ 做空 ES（順勢等修正）
    else if (curVix < this.vixLow && vixSpike < 0) {
      this._stopPrice = bar.close + curAtr * this.atrStop;
      this._position = -1;
      this._heldBars = 0;
      this.signal(
        "sell",
        `VIX=${curVix.toFixed(1)} < ${this.vixLow}（低波進場做空）SMA=${vixSma.toFixed(1)}`,
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 3. Commodity Seasonality Strategy
// ══════════════════════════════════════════════════════════════════
/**
 * 原油/黃金季節性策略
 * - 基於歷史統計：原油 Q1 夏季駕車季前易漲；黃金 Q4 珠寶需求易漲
 * - 結合 MA 趨勢過濾
 */
export class CommoditySeasonalityStrategy extends BaseStrategy {
  /**
   * @param {object} opts
   * @param {object} opts.params.seasonBias   月份偏向（1-12 → 'long'|'short'|null）
   *                 預設原油：{ 1:'long', 2:'long', 6:'short', 7:'short', 8:'long', 9:'long', 10:'short' }
   * @param {number} opts.params.maPeriod     MA 趨勢確認週期（預設 20）
   * @param {number} opts.params.atrStop      ATR 倍數止損（預設 2）
   */
  constructor(opts = {}) {
    super(opts);

    // 預設：CL（原油）季節性偏向
    const defaultSeason = opts.instrument?.startsWith("GC")
      ? { 8: "long", 9: "long", 10: "long", 11: "long", 1: "short", 2: "short" } // 黃金 Q3-Q4 偏多
      : { 1: "long", 2: "long", 6: "short", 9: "long", 10: "long", 11: "short" }; // 原油

    this.seasonBias = this.params.seasonBias ?? defaultSeason;
    this.maPeriod = this.params.maPeriod ?? 20;
    this.atrStop = this.params.atrStop ?? 2;

    this._position = 0;
    this._stopPrice = 0;
    this._curMonth = 0;
  }

  onBar(bar) {
    this.addBar(bar);
    if (this.barCount() < this.maPeriod + 2) {
      return;
    }

    const month = new Date(bar.time).getMonth() + 1;
    const bias = this.seasonBias[month] ?? null;
    const closes = this.closes();
    const ma = sma(closes, this.maPeriod);
    const curAtr = atr(this._priceHistory, 14) ?? bar.high - bar.low;

    // 季節性偏向改變 → 平倉
    if (this._position !== 0) {
      const posBias = this._position > 0 ? "long" : "short";
      if (bias !== posBias) {
        this.signal(
          this._position > 0 ? "close_long" : "close_short",
          `季節性翻轉 月份=${month} bias=${bias}`,
        );
        this._position = 0;
      }
      // 止損
      if (this._position > 0 && bar.low <= this._stopPrice) {
        this.signal("close_long", `季節止損 ${bar.low} ≤ ${this._stopPrice.toFixed(1)}`);
        this._position = 0;
      } else if (this._position < 0 && bar.high >= this._stopPrice) {
        this.signal("close_short", `季節止損 ${bar.high} ≥ ${this._stopPrice.toFixed(1)}`);
        this._position = 0;
      }
      return;
    }

    if (!bias) {
      return;
    }

    // 趨勢確認：MA 順向
    const trendOk = bias === "long" ? bar.close > ma : bar.close < ma;
    if (!trendOk) {
      return;
    }

    if (bias === "long" && this._position === 0) {
      this._stopPrice = bar.close - curAtr * this.atrStop;
      this._position = 1;
      this.signal(
        "buy",
        `季節多 月=${month} MA=${ma?.toFixed(1)} 止損=${this._stopPrice.toFixed(1)}`,
      );
    } else if (bias === "short" && this._position === 0) {
      this._stopPrice = bar.close + curAtr * this.atrStop;
      this._position = -1;
      this.signal(
        "sell",
        `季節空 月=${month} MA=${ma?.toFixed(1)} 止損=${this._stopPrice.toFixed(1)}`,
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 4. Global Momentum Rotation
// ══════════════════════════════════════════════════════════════════
/**
 * 跨市場動能輪動
 * - 每根 K 棒計算多個商品的過去 N 根報酬率排名
 * - 做多最強商品、做空最弱商品（或只做多）
 * - 適用於日線/週線
 */
export class GlobalMomentumStrategy extends BaseStrategy {
  /**
   * @param {object} opts
   * @param {string[]} opts.params.symbols      商品列表（預設 ['ES','NQ','GC','CL']）
   * @param {number}   opts.params.lookback     動能回望根數（預設 20）
   * @param {number}   opts.params.topN         做多前 N 名（預設 1）
   * @param {boolean}  opts.params.shortBottom  是否做空最後 N 名（預設 false）
   */
  constructor(opts = {}) {
    super(opts);
    this.symbols = this.params.symbols ?? ["ES", "NQ", "GC", "CL"];
    this.lookback = this.params.lookback ?? 20;
    this.topN = this.params.topN ?? 1;
    this.shortBottom = this.params.shortBottom ?? false;

    // 各商品歷史收盤價
    this._prices = new Map(this.symbols.map((s) => [s, []]));
    this._positions = new Map(this.symbols.map((s) => [s, 0]));
  }

  /** 外部更新某商品的最新收盤價 */
  updatePrice(symbol, close) {
    if (!this._prices.has(symbol)) {
      this._prices.set(symbol, []);
    }
    const arr = this._prices.get(symbol);
    arr.push(close);
    if (arr.length > this.lookback + 5) {
      arr.shift();
    }
  }

  onBar(bar) {
    this.addBar(bar);
    // 主商品也更新
    this.updatePrice(this.instrument, bar.close);

    // 確認所有商品都有足夠資料
    const allReady = [...this._prices.values()].every((p) => p.length >= this.lookback);
    if (!allReady) {
      return;
    }

    // 計算動能（N 根報酬率）
    const momentum = this.symbols
      .map((sym) => {
        const prices = this._prices.get(sym);
        const ret =
          (prices[prices.length - 1] - prices[prices.length - this.lookback]) /
          prices[prices.length - this.lookback];
        return { sym, ret };
      })
      .toSorted((a, b) => b.ret - a.ret);

    const topSymbols = new Set(momentum.slice(0, this.topN).map((x) => x.sym));
    const bottomSymbols = new Set(momentum.slice(-this.topN).map((x) => x.sym));

    // 發出目前主商品的訊號
    const myRank = momentum.findIndex((x) => x.sym === this.instrument);
    const curPos = this._positions.get(this.instrument) ?? 0;

    if (topSymbols.has(this.instrument) && curPos <= 0) {
      if (curPos < 0) {
        this.signal("close_short", `動能輪動 ${this.instrument} 上升到前 ${this.topN} 名`);
      }
      this.signal(
        "buy",
        `動能輪動 做多 ${this.instrument} 排名第 ${myRank + 1}/${this.symbols.length}`,
      );
      this._positions.set(this.instrument, 1);
    } else if (!topSymbols.has(this.instrument) && curPos > 0) {
      this.signal(
        "close_long",
        `動能輪動 ${this.instrument} 跌出前 ${this.topN} 名（排名 ${myRank + 1}）`,
      );
      this._positions.set(this.instrument, 0);
    }

    if (this.shortBottom && bottomSymbols.has(this.instrument) && curPos >= 0) {
      if (curPos > 0) {
        this.signal("close_long", `動能輪動 ${this.instrument} 下降到末 ${this.topN} 名`);
      }
      this.signal(
        "sell",
        `動能輪動 做空 ${this.instrument} 排名第 ${myRank + 1}/${this.symbols.length}`,
      );
      this._positions.set(this.instrument, -1);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 5. Overnight Gap Fade Strategy
// ══════════════════════════════════════════════════════════════════
/**
 * 隔夜跳空回補策略
 * - 亞盤/歐盤開盤時若有顯著跳空，賭回補到昨日收盤
 * - 適用：ES（全電子盤）、NQ、CL、GC
 */
export class OvernightGapFadeStrategy extends BaseStrategy {
  /**
   * @param {object} opts
   * @param {number} opts.params.minGapPct   最小跳空比例（預設 0.003 = 0.3%）
   * @param {number} opts.params.maxGapPct   最大跳空（超過不追，預設 0.015 = 1.5%）
   * @param {number} opts.params.atrStop     ATR 倍數止損（預設 1.0）
   * @param {number} opts.params.holdBars    最大持倉根數（預設 12）
   * @param {string} opts.params.gapSession  跳空觀察時段開始（'08:00' 台灣時間，預設亞盤）
   */
  constructor(opts = {}) {
    super(opts);
    this.minGapPct = this.params.minGapPct ?? 0.003;
    this.maxGapPct = this.params.maxGapPct ?? 0.015;
    this.atrStop = this.params.atrStop ?? 1.0;
    this.holdBars = this.params.holdBars ?? 12;
    this.gapSession = this.params.gapSession ?? "08:00";

    this._prevClose = null;
    this._lastDate = "";
    this._gapChecked = false;
    this._position = 0;
    this._stopPrice = 0;
    this._heldBars = 0;
    this._target = null; // 目標（昨日收盤）
  }

  onBar(bar) {
    this.addBar(bar);
    const barDate = bar.time?.slice(0, 10) ?? "";
    const barTime = bar.time?.slice(11, 16) ?? "";

    // 新的一天
    if (barDate !== this._lastDate) {
      if (this._lastDate && this._priceHistory.length >= 2) {
        // 取昨日最後一根 K 棒的收盤作為 prevClose
        const yesterdayBars = this._priceHistory.filter(
          (b) => b.time?.slice(0, 10) === this._lastDate,
        );
        this._prevClose =
          yesterdayBars.length > 0 ? yesterdayBars[yesterdayBars.length - 1].close : null;
      }
      this._lastDate = barDate;
      this._gapChecked = false;
    }

    // 持倉止損/止盈/時間
    if (this._position !== 0) {
      this._heldBars++;
      const reachedTarget = this._position > 0 ? bar.high >= this._target : bar.low <= this._target;

      if (reachedTarget) {
        this.signal(
          this._position > 0 ? "close_long" : "close_short",
          `跳空回補至目標 ${this._target?.toFixed(2)}`,
        );
        this._position = 0;
        return;
      }
      if (this._position > 0 && bar.low <= this._stopPrice) {
        this.signal("close_long", `跳空止損 ${bar.low} ≤ ${this._stopPrice.toFixed(2)}`);
        this._position = 0;
        return;
      }
      if (this._position < 0 && bar.high >= this._stopPrice) {
        this.signal("close_short", `跳空止損 ${bar.high} ≥ ${this._stopPrice.toFixed(2)}`);
        this._position = 0;
        return;
      }
      if (this._heldBars >= this.holdBars) {
        this.signal(
          this._position > 0 ? "close_long" : "close_short",
          `跳空持倉到期 ${this._heldBars} 根`,
        );
        this._position = 0;
      }
      return;
    }

    // 只在特定時段開始後的第一根 K 棒偵測跳空
    if (this._gapChecked || barTime < this.gapSession || !this._prevClose) {
      return;
    }
    this._gapChecked = true;

    const gapPct = (bar.open - this._prevClose) / this._prevClose;
    const absGap = Math.abs(gapPct);

    if (absGap < this.minGapPct || absGap > this.maxGapPct) {
      return;
    }

    const curAtr = atr(this._priceHistory, 14) ?? Math.abs(bar.high - bar.low) * 5;

    if (gapPct > 0) {
      // 跳空開高 → 做空，賭回補到昨日收盤
      this._target = this._prevClose;
      this._stopPrice = bar.open + curAtr * this.atrStop;
      this._position = -1;
      this._heldBars = 0;
      this.signal(
        "sell",
        `隔夜跳空 +${(gapPct * 100).toFixed(2)}% open=${bar.open} prevClose=${this._prevClose.toFixed(2)} stop=${this._stopPrice.toFixed(2)}`,
      );
    } else {
      // 跳空開低 → 做多，賭回補到昨日收盤
      this._target = this._prevClose;
      this._stopPrice = bar.open - curAtr * this.atrStop;
      this._position = 1;
      this._heldBars = 0;
      this.signal(
        "buy",
        `隔夜跳空 ${(gapPct * 100).toFixed(2)}% open=${bar.open} prevClose=${this._prevClose.toFixed(2)} stop=${this._stopPrice.toFixed(2)}`,
      );
    }
  }
}

// ── 策略摘要 ──────────────────────────────────────────────────────
export const OVERSEAS_STRATEGY_INFO = {
  OpeningRangeBreakoutStrategy: {
    bestFor: ["ES", "NQ", "YM", "RTY"],
    timeframe: "5min / 1min",
    type: "breakout",
    desc: "美股開盤區間突破，適合波動較大的美股指數期貨",
  },
  VixMeanReversionStrategy: {
    bestFor: ["ES", "MES"],
    timeframe: "1day / 4hour",
    type: "mean_reversion",
    desc: "VIX 恐慌指數均值回歸，適合日線操作",
    extra: "需同時訂閱 VX（VIX 期貨）行情",
  },
  CommoditySeasonalityStrategy: {
    bestFor: ["CL", "GC", "NG", "SI"],
    timeframe: "1day",
    type: "seasonality",
    desc: "原油/黃金季節性偏向，結合 MA 趨勢過濾",
  },
  GlobalMomentumStrategy: {
    bestFor: ["ES", "NQ", "GC", "CL"],
    timeframe: "1day / 1week",
    type: "momentum",
    desc: "跨市場動能輪動，做多最強商品，適合低頻",
    extra: "需同時接收多商品行情並呼叫 updatePrice()",
  },
  OvernightGapFadeStrategy: {
    bestFor: ["ES", "NQ", "GC", "CL"],
    timeframe: "5min / 15min",
    type: "gap_fade",
    desc: "隔夜跳空回補，亞盤開盤時捕捉跳空機會",
  },
};
