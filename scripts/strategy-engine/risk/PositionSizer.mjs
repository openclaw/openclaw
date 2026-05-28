// PositionSizer.mjs — 科學化倉位計算模組
// 支援: Kelly Criterion / ATR 固定風險 / 波動率目標 / 固定比例
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function fallbackMean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
  return total / values.length;
}

function fallbackStandardDeviation(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const mean = fallbackMean(values);
  const variance =
    values.reduce((sum, value) => {
      const delta = Number(value || 0) - mean;
      return sum + delta * delta;
    }, 0) / values.length;
  return Math.sqrt(variance);
}

function asPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function asRatioFromPercent(value) {
  const numeric = asPositiveNumber(value);
  if (!numeric) {
    return null;
  }
  return numeric / 100;
}

let ss = {
  mean: fallbackMean,
  standardDeviation: fallbackStandardDeviation,
};

try {
  ss = require("simple-statistics");
} catch {}

let AtrIndicator = null;
try {
  AtrIndicator = require("technicalindicators").ATR ?? null;
} catch {}

// ══════════════════════════════════════════════
// Kelly Criterion — 最優倉位比例
// f* = (p/|avgLoss|) - ((1-p)/avgWin)  [整數Kelly]
// 實務上取半Kelly（f*/2）降低波動
// ══════════════════════════════════════════════
export function kellyFraction(winRate, avgWin, avgLoss) {
  if (winRate <= 0 || winRate >= 1 || avgWin <= 0 || avgLoss >= 0) {
    return 0;
  }
  const p = winRate;
  const q = 1 - p;
  const b = avgWin / Math.abs(avgLoss); // 盈虧比
  const f = (p * b - q) / b; // Kelly 公式
  return Math.max(0, Math.min(f, 1)); // 限制在 [0, 1]
}

export function halfKelly(winRate, avgWin, avgLoss) {
  return kellyFraction(winRate, avgWin, avgLoss) / 2;
}

// ══════════════════════════════════════════════
// ATR 固定風險法（Van Tharp N-系統）
// 每筆風險 = 帳戶 × riskPct
// 倉位 = 每筆風險 / (ATR × pointValue × stopMultiple)
// ══════════════════════════════════════════════
export function atrPositionSize({
  capital,
  riskPct = 0.01, // 每筆最大虧損佔帳戶比例（預設 1%）
  atr, // 最新 ATR 值
  pointValue = 200, // 每點價值（台指 200 元）
  stopMultiple = 2, // 止損設在幾倍 ATR
  minQty = 1,
  maxQty = 10,
}) {
  if (!atr || atr <= 0) {
    return minQty;
  }
  const riskAmount = capital * riskPct;
  const riskPerUnit = atr * pointValue * stopMultiple;
  const qty = Math.floor(riskAmount / riskPerUnit);
  return Math.max(minQty, Math.min(qty, maxQty));
}

// ══════════════════════════════════════════════
// 波動率目標法（AQR / Risk Parity 常用）
// 目標年化波動率 targetVolPct，動態調整槓桿
// qty = (capital × targetVol) / (realizedVol × pointValue × price)
// ══════════════════════════════════════════════
export function volTargetSize({
  capital,
  targetVolPct = 0.1, // 目標年化波動率 10%
  realizedVol, // 實際年化波動率（以日報酬標準差 × √252 計算）
  price,
  pointValue = 200,
  minQty = 1,
  maxQty = 10,
}) {
  if (!realizedVol || realizedVol <= 0 || !price) {
    return minQty;
  }
  const targetCapital = capital * (targetVolPct / realizedVol);
  const qty = Math.floor(targetCapital / (price * pointValue));
  return Math.max(minQty, Math.min(qty, maxQty));
}

// ══════════════════════════════════════════════
// PositionSizer 主類別 — 整合所有方法
// ══════════════════════════════════════════════
export class PositionSizer {
  constructor(config = {}) {
    this.method = config.method ?? "atr"; // 'kelly' | 'atr' | 'vol_target' | 'fixed'
    this.capital = config.capital ?? 1_000_000;
    this.pointValue = config.pointValue ?? 200;
    this.riskPct = config.riskPct ?? 0.01;
    this.targetVol = config.targetVol ?? 0.1;
    this.stopMult = config.stopMult ?? 2;
    this.minQty = config.minQty ?? 1;
    this.maxQty = config.maxQty ?? 10;
    this.halfKelly = config.halfKelly ?? true;
    this.riskPerTradePct = asPositiveNumber(config.riskPerTradePct);
    this.maxMarginUtilPct = asPositiveNumber(config.maxMarginUtilPct);

    // 策略績效追蹤（用於 Kelly）
    this._trades = [];
  }

  /** 計算倉位口數
   * @param {{ bars, price, atr, winRate, avgWin, avgLoss, realizedVol }} ctx
   */
  calc(ctx = {}) {
    let qty = this.minQty;
    const riskBasedQty = this._calcRiskBasedQty(ctx);
    if (riskBasedQty != null) {
      qty = riskBasedQty;
    } else {
      switch (this.method) {
        case "kelly": {
          const wR = ctx.winRate ?? this._calcWinRate();
          const aW = ctx.avgWin ?? this._calcAvgWin();
          const aL = ctx.avgLoss ?? this._calcAvgLoss();
          const f = this.halfKelly ? halfKelly(wR, aW, aL) : kellyFraction(wR, aW, aL);
          qty = Math.floor((this.capital * f) / ((ctx.price ?? 1) * this.pointValue));
          break;
        }
        case "atr": {
          const atr = ctx.atr ?? this._calcAtr(ctx.bars);
          qty = atrPositionSize({
            capital: this.capital,
            riskPct: this.riskPct,
            atr,
            pointValue: this.pointValue,
            stopMultiple: this.stopMult,
            minQty: this.minQty,
            maxQty: this.maxQty,
          });
          break;
        }
        case "vol_target": {
          const rv = ctx.realizedVol ?? this._calcRealizedVol(ctx.bars);
          qty = volTargetSize({
            capital: this.capital,
            targetVolPct: this.targetVol,
            realizedVol: rv,
            price: ctx.price ?? 1,
            pointValue: this.pointValue,
            minQty: this.minQty,
            maxQty: this.maxQty,
          });
          break;
        }
        default:
          qty = this.minQty;
          break;
      }
    }

    if (ctx.margin && ctx.maxPositionPct && this.capital > 0) {
      const maxByMargin = Math.floor((this.capital * ctx.maxPositionPct) / ctx.margin);
      qty = Math.min(qty, maxByMargin);
    }

    return Math.max(this.minQty, Math.min(qty || this.minQty, this.maxQty));
  }

  _calcRiskBasedQty(ctx = {}) {
    const riskPerTradeRatio =
      asRatioFromPercent(ctx.riskPerTradePct) ?? asRatioFromPercent(this.riskPerTradePct);
    if (!riskPerTradeRatio) {
      return null;
    }
    const capital = asPositiveNumber(ctx.capital) ?? asPositiveNumber(this.capital);
    if (!capital) {
      return null;
    }
    const pointValue = asPositiveNumber(ctx.pointValue) ?? asPositiveNumber(this.pointValue);
    if (!pointValue) {
      return null;
    }
    const atr = asPositiveNumber(ctx.atr) ?? this._calcAtr(ctx.bars);
    const stopMultiple = asPositiveNumber(ctx.stopMultiple) ?? asPositiveNumber(this.stopMult) ?? 1;
    const stopDistance =
      asPositiveNumber(ctx.stopDistance) ?? (atr > 0 ? atr * stopMultiple : null);
    if (!stopDistance) {
      return null;
    }
    const riskAmount = capital * riskPerTradeRatio;
    const perContractRisk = stopDistance * pointValue;
    if (!Number.isFinite(perContractRisk) || perContractRisk <= 0) {
      return null;
    }
    let qty = Math.floor(riskAmount / perContractRisk);
    if (!Number.isFinite(qty) || qty <= 0) {
      qty = 1;
    }
    const maxMarginUtilRatio =
      asRatioFromPercent(ctx.maxMarginUtilPct) ?? asRatioFromPercent(this.maxMarginUtilPct);
    const margin = asPositiveNumber(ctx.margin);
    if (maxMarginUtilRatio && margin) {
      const marginCapQty = Math.floor((capital * maxMarginUtilRatio) / margin);
      qty = Math.min(qty, marginCapQty);
    }
    return Math.max(1, qty);
  }

  /** 更新帳戶資金 */
  updateCapital(newCapital) {
    this.capital = newCapital;
  }

  /** 記錄交易結果（供 Kelly 計算） */
  recordTrade(pnl) {
    this._trades.push(pnl);
    if (this._trades.length > 100) {
      this._trades.shift();
    }
  }

  _calcWinRate() {
    if (!this._trades.length) {
      return 0.5;
    }
    return this._trades.filter((p) => p > 0).length / this._trades.length;
  }
  _calcAvgWin() {
    const wins = this._trades.filter((p) => p > 0);
    return wins.length ? ss.mean(wins) : 1000;
  }
  _calcAvgLoss() {
    const losses = this._trades.filter((p) => p <= 0);
    return losses.length ? ss.mean(losses) : -500;
  }
  _calcAtr(bars, period = 14) {
    if (!bars || bars.length < period + 1) {
      return 0;
    }
    if (AtrIndicator?.calculate) {
      const res = AtrIndicator.calculate({
        period,
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close: bars.map((b) => b.close),
      });
      return res[res.length - 1] ?? 0;
    }
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const high = Number(bars[i]?.high ?? 0);
      const low = Number(bars[i]?.low ?? 0);
      const prevClose = Number(bars[i - 1]?.close ?? 0);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    if (trs.length < period) {
      return 0;
    }
    const tail = trs.slice(-period);
    return tail.reduce((sum, value) => sum + value, 0) / tail.length;
  }
  _calcRealizedVol(bars, lookback = 20) {
    if (!bars || bars.length < lookback + 1) {
      return 0.15;
    }
    const prices = bars.slice(-lookback - 1).map((b) => b.close);
    const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
    return ss.standardDeviation(returns) * Math.sqrt(252);
  }
}
