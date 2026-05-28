// StopLossManager.mjs — 統一止損/止盈框架
// 整合至 BaseStrategy，提供多種止損方式
//
// 止損類型：
//   fixed       — 固定點數止損（entryPrice ± stopTicks）
//   pct         — 百分比止損（entryPrice × (1 ± stopPct)）
//   atr         — ATR 倍數止損（entryPrice ± atrMultiple × ATR）
//   trailing    — 移動止損（追蹤最高/最低價，回撤 trailPct 即觸發）
//   chandelier  — Chandelier 止損（最高/低點 ± atrMultiple × ATR）
//   time        — 時間止損（超過 maxBars 根K棒即平倉）
//   combo       — 組合：以上任一條件觸發即止損
//
// 止盈類型：
//   fixed_tp    — 固定點數止盈
//   rr          — Risk:Reward 倍數（stopLoss × rrRatio）
//   partial     — 分批止盈（到達 tp1 平一半，到達 tp2 全平）

import { ATR } from "technicalindicators";

export class StopLossManager {
  /**
   * @param {object} config
   * @param {string}  config.type        止損類型（預設 'atr'）
   * @param {number}  config.stopTicks   fixed 止損點數
   * @param {number}  config.stopPct     pct 止損百分比（0.02 = 2%）
   * @param {number}  config.atrPeriod   ATR 週期（預設 14）
   * @param {number}  config.atrMultiple ATR 倍數（預設 2）
   * @param {number}  config.trailPct    Trailing 回撤百分比（0.015 = 1.5%）
   * @param {number}  config.maxBars     Time 止損 K 棒數（預設 20）
   * @param {number}  config.rrRatio     Risk:Reward 倍數（止盈=止損×rrRatio，預設 2）
   * @param {boolean} config.usePartial  是否分批止盈
   * @param {number}  config.tp1Ratio    第一批止盈比率（預設 1.0 = 1×stop）
   * @param {number}  config.tp2Ratio    第二批止盈比率（預設 2.0 = 2×stop）
   */
  constructor(config = {}) {
    this.type = config.type ?? "atr";
    this.stopTicks = config.stopTicks ?? 50;
    this.stopPct = config.stopPct ?? 0.02;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.atrMultiple = config.atrMultiple ?? 2;
    this.trailPct = config.trailPct ?? 0.015;
    this.maxBars = config.maxBars ?? 20;
    this.rrRatio = config.rrRatio ?? 2;
    this.usePartial = config.usePartial ?? false;
    this.tp1Ratio = config.tp1Ratio ?? 1.0;
    this.tp2Ratio = config.tp2Ratio ?? 2.0;

    this.reset();
  }

  // ── 開倉時初始化 ──────────────────────────────────────────────
  /**
   * @param {'long'|'short'} direction
   * @param {number}         entryPrice
   * @param {object[]}       bars        priceHistory（用於計算 ATR）
   */
  open(direction, entryPrice, bars = []) {
    this._direction = direction;
    this._entryPrice = entryPrice;
    this._barsHeld = 0;
    this._partialFilled = false;

    // 計算止損距離
    const stopDist = this._calcStopDist(entryPrice, bars);
    const isLong = direction === "long";

    this._stopPrice = isLong ? entryPrice - stopDist : entryPrice + stopDist;

    // 止盈
    this._tp1Price = isLong
      ? entryPrice + stopDist * this.tp1Ratio * this.rrRatio
      : entryPrice - stopDist * this.tp1Ratio * this.rrRatio;
    this._tp2Price = isLong
      ? entryPrice + stopDist * this.tp2Ratio * this.rrRatio
      : entryPrice - stopDist * this.tp2Ratio * this.rrRatio;

    // Trailing 初始峰值
    this._peakPrice = entryPrice;
    this._trailStop = isLong ? entryPrice * (1 - this.trailPct) : entryPrice * (1 + this.trailPct);

    this._active = true;
    this._stopDist = stopDist;
  }

  /**
   * 每根 K 棒呼叫，回傳是否應平倉
   * @param {object} bar  { high, low, close }
   * @param {object[]} bars  完整 priceHistory
   * @returns {{ exit: boolean, reason: string, partial: boolean }}
   */
  onBar(bar, bars = []) {
    if (!this._active) {
      return { exit: false, reason: "", partial: false };
    }

    this._barsHeld++;
    const isLong = this._direction === "long";
    const price = bar.close;

    // ── 更新移動止損 & Chandelier ─────────────────────────────
    if (this.type === "trailing" || this.type === "combo") {
      if (isLong) {
        this._peakPrice = Math.max(this._peakPrice, bar.high);
        this._trailStop = this._peakPrice * (1 - this.trailPct);
      } else {
        this._peakPrice = Math.min(this._peakPrice, bar.low);
        this._trailStop = this._peakPrice * (1 + this.trailPct);
      }
    }

    if (this.type === "chandelier" || this.type === "combo") {
      const atrVal = this._calcAtr(bars);
      if (atrVal > 0) {
        if (isLong) {
          const peak = Math.max(...bars.slice(-this.atrPeriod).map((b) => b.high));
          this._chanStop = peak - this.atrMultiple * atrVal;
        } else {
          const trough = Math.min(...bars.slice(-this.atrPeriod).map((b) => b.low));
          this._chanStop = trough + this.atrMultiple * atrVal;
        }
      }
    }

    // ── ATR 止損：每根 K 棒動態更新 ─────────────────────────
    if (this.type === "atr") {
      const atrVal = this._calcAtr(bars);
      if (atrVal > 0) {
        const newStop = isLong
          ? this._entryPrice - this.atrMultiple * atrVal
          : this._entryPrice + this.atrMultiple * atrVal;
        // 只往對自己有利方向移動（不退縮）
        if (isLong) {
          this._stopPrice = Math.max(this._stopPrice, newStop);
        } else {
          this._stopPrice = Math.min(this._stopPrice, newStop);
        }
      }
    }

    // ── 分批止盈 ─────────────────────────────────────────────
    if (this.usePartial && !this._partialFilled) {
      const tp1Hit = isLong ? price >= this._tp1Price : price <= this._tp1Price;
      if (tp1Hit) {
        this._partialFilled = true;
        return { exit: false, reason: `TP1 達到 @${price.toFixed(1)}`, partial: true };
      }
    }

    // ── 止盈（全部）─────────────────────────────────────────
    const tp2 = this.usePartial ? this._tp2Price : this._tp1Price;
    const tpHit = isLong ? price >= tp2 : price <= tp2;
    if (tpHit) {
      return this._exit(`🎯 止盈 @${price.toFixed(1)} (目標 ${tp2.toFixed(1)})`);
    }

    // ── 時間止損 ─────────────────────────────────────────────
    if ((this.type === "time" || this.type === "combo") && this._barsHeld >= this.maxBars) {
      return this._exit(`⏱️ 時間止損 持倉 ${this._barsHeld} 根K棒`);
    }

    // ── 各類止損觸發 ─────────────────────────────────────────
    const stopPrice = this._effectiveStop();
    const slHit = isLong ? price <= stopPrice : price >= stopPrice;
    if (slHit) {
      return this._exit(`🛑 止損 @${price.toFixed(1)} (止損線 ${stopPrice.toFixed(1)})`);
    }

    return { exit: false, reason: "", partial: false };
  }

  // ── 狀態查詢 ─────────────────────────────────────────────────
  isActive() {
    return this._active;
  }
  getStopPrice() {
    return this._effectiveStop();
  }
  getTpPrice() {
    return this._tp1Price;
  }
  getBarsHeld() {
    return this._barsHeld;
  }

  reset() {
    this._active = false;
    this._direction = null;
    this._entryPrice = 0;
    this._stopPrice = 0;
    this._tp1Price = 0;
    this._tp2Price = 0;
    this._peakPrice = 0;
    this._trailStop = 0;
    this._chanStop = 0;
    this._barsHeld = 0;
    this._stopDist = 0;
    this._partialFilled = false;
  }

  // ── 內部 ─────────────────────────────────────────────────────
  _effectiveStop() {
    switch (this.type) {
      case "trailing":
        return this._trailStop;
      case "chandelier":
        return this._chanStop || this._stopPrice;
      case "combo": {
        // 取對自己最有利的止損線（最靠近當前價格保護最多的那條）
        const stops = [this._stopPrice, this._trailStop, this._chanStop].filter(Boolean);
        return this._direction === "long" ? Math.max(...stops) : Math.min(...stops);
      }
      default:
        return this._stopPrice;
    }
  }

  _calcStopDist(entryPrice, bars) {
    switch (this.type) {
      case "fixed":
        return this.stopTicks;
      case "pct":
        return entryPrice * this.stopPct;
      case "trailing":
        return entryPrice * this.trailPct;
      case "time":
        return entryPrice * 0.02; // time止損預設2%止損
      case "atr":
      case "chandelier":
      case "combo":
        return (this._calcAtr(bars) || entryPrice * 0.01) * this.atrMultiple;
      default:
        return entryPrice * 0.02;
    }
  }

  _calcAtr(bars) {
    if (!bars || bars.length < this.atrPeriod + 1) {
      return 0;
    }
    const recent = bars.slice(-this.atrPeriod - 1);
    const res = ATR.calculate({
      period: this.atrPeriod,
      high: recent.map((b) => b.high),
      low: recent.map((b) => b.low),
      close: recent.map((b) => b.close),
    });
    return res[res.length - 1] ?? 0;
  }

  _exit(reason) {
    this._active = false;
    return { exit: true, reason, partial: false };
  }
}

// ── Mixin：替 BaseStrategy 加上 StopLossManager ───────────────────
/**
 * 用法：在 Strategy 的 constructor 呼叫 attachStopLoss(this, config)
 * 之後在 onBar 呼叫 this._checkStop(bar) 取得平倉訊號
 */
export function attachStopLoss(strategy, slConfig = {}) {
  strategy._sl = new StopLossManager(slConfig);

  // 覆寫 signal() 以自動記錄開倉
  const _origSignal = strategy.signal.bind(strategy);
  strategy.signal = function (direction, reason, qty) {
    const sig = _origSignal(direction, reason, qty);
    const bar = strategy.lastBar?.();
    if (bar) {
      if (direction === "buy") {
        strategy._sl.open("long", bar.close, strategy._priceHistory);
      } else if (direction === "sell") {
        strategy._sl.open("short", bar.close, strategy._priceHistory);
      } else if (direction === "close_long" || direction === "close_short") {
        strategy._sl.reset();
      }
    }
    return sig;
  };

  // 注入 stop 檢查方法
  strategy._checkStop = function (bar) {
    if (!strategy._sl.isActive()) {
      return;
    }
    const result = strategy._sl.onBar(bar, strategy._priceHistory);
    if (result.partial) {
      // 分批止盈：平一半
      const halfQty = Math.max(1, Math.floor((strategy.maxQty ?? 1) / 2));
      const dir = strategy._sl._direction === "long" ? "close_long" : "close_short";
      strategy.signal(dir, `[分批止盈] ${result.reason}`, halfQty);
    } else if (result.exit) {
      const dir = strategy._sl._direction === "long" ? "close_long" : "close_short";
      strategy.signal(dir, result.reason, strategy.maxQty ?? 1);
      strategy._sl.reset();
      if (strategy._position !== undefined) {
        strategy._position = 0;
      }
    }
  };
}
