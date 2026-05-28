// OptionsStrategy.mjs — Black-Scholes 期權定價 + Greeks + 策略組合
// 功能：
//   1. Black-Scholes 定價 (call/put)
//   2. Greeks: Delta, Gamma, Vega, Theta, Rho
//   3. 隱含波動率 (IV) 二分搜尋
//   4. Iron Condor / Straddle / Strangle 策略
//   5. Delta 中性對沖建議

// ── Black-Scholes 核心 ───────────────────────────────────────────────
const SQRT2PI = Math.sqrt(2 * Math.PI);

/** 標準常態分佈 CDF (Abramowitz & Stegun 近似) */
function normCdf(x) {
  if (x < -6) {
    return 0;
  }
  if (x > 6) {
    return 1;
  }
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / SQRT2PI;
  const cdf = 1 - pdf * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** 標準常態分佈 PDF */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/**
 * Black-Scholes 定價
 * @param {object} p
 * @param {number}  p.S   現貨價格
 * @param {number}  p.K   行使價
 * @param {number}  p.T   到期時間（年）
 * @param {number}  p.r   無風險利率（小數，如 0.02）
 * @param {number}  p.sigma 年化波動率（小數）
 * @param {'call'|'put'} p.type
 * @returns {{ price, d1, d2, delta, gamma, vega, theta, rho }}
 */
export function blackScholes(params) {
  const { S, K, T, r, sigma } = params;
  const type = params.type ?? "call";
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    return {
      price: intrinsic,
      d1: 0,
      d2: 0,
      delta: intrinsic > 0 ? (type === "call" ? 1 : -1) : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
      rho: 0,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const Nnd1 = normCdf(-d1);
  const Nnd2 = normCdf(-d2);
  const nd1 = normPdf(d1);

  const discK = K * Math.exp(-r * T);

  let price, delta, rho;
  if (type === "call") {
    price = S * Nd1 - discK * Nd2;
    delta = Nd1;
    rho = (K * T * Math.exp(-r * T) * Nd2) / 100;
  } else {
    price = discK * Nnd2 - S * Nnd1;
    delta = Nd1 - 1;
    rho = (-K * T * Math.exp(-r * T) * Nnd2) / 100;
  }

  const gamma = nd1 / (S * sigma * sqrtT);
  const vega = (S * nd1 * sqrtT) / 100; // per 1% vol move
  const theta =
    (-(S * nd1 * sigma) / (2 * sqrtT) - r * discK * (type === "call" ? Nd2 : -Nnd2)) / 365;

  return {
    price: +price.toFixed(4),
    d1: +d1.toFixed(4),
    d2: +d2.toFixed(4),
    delta: +delta.toFixed(4),
    gamma: +gamma.toFixed(6),
    vega: +vega.toFixed(4),
    theta: +theta.toFixed(4),
    rho: +rho.toFixed(4),
  };
}

/**
 * 隱含波動率（二分搜尋）
 * @param {object} p  同 blackScholes，但不含 sigma；需多傳 marketPrice
 * @returns {number|null} IV 或 null（無解）
 */
export function impliedVolatility({ S, K, T, r, type, marketPrice }) {
  let lo = 0.001,
    hi = 5.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const price = blackScholes({ S, K, T, r, sigma: mid, type }).price;
    if (Math.abs(price - marketPrice) < 0.0001) {
      return +mid.toFixed(4);
    }
    if (price < marketPrice) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const result = (lo + hi) / 2;
  return result < 4.9 ? +result.toFixed(4) : null;
}

// ── 期權鏈分析 ────────────────────────────────────────────────────────
/**
 * 建立期權鏈（一系列行使價的Greeks）
 * @param {object} params
 * @param {number}   params.S       現貨
 * @param {number[]} params.strikes 行使價陣列
 * @param {number}   params.T       到期（年）
 * @param {number}   params.r       利率
 * @param {number}   params.sigma   波動率
 * @returns {Array}
 */
export function buildOptionChain({ S, strikes, T, r, sigma }) {
  return strikes.map((K) => {
    const call = blackScholes({ S, K, T, r, sigma, type: "call" });
    const put = blackScholes({ S, K, T, r, sigma, type: "put" });
    const moneyness = S > K ? "ITM" : S < K ? "OTM" : "ATM";
    return {
      K,
      moneyness,
      call: {
        price: call.price,
        delta: call.delta,
        gamma: call.gamma,
        vega: call.vega,
        theta: call.theta,
      },
      put: {
        price: put.price,
        delta: put.delta,
        gamma: put.gamma,
        vega: put.vega,
        theta: put.theta,
      },
    };
  });
}

// ── 策略組合 PnL 計算 ─────────────────────────────────────────────────
/**
 * 計算策略組合的 PnL 曲線（到期時）
 * @param {Array} legs  [{ type, K, qty, premium }] qty>0=買, qty<0=賣
 * @param {number[]} priceRange  現貨價格範圍
 * @returns {Array} [{ S, pnl }]
 */
export function strategyPnlAtExpiry(legs, priceRange) {
  return priceRange.map((S) => {
    const pnl = legs.reduce((sum, { type, K, qty, premium }) => {
      const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
      return sum + qty * (intrinsic - premium);
    }, 0);
    return { S: +S.toFixed(0), pnl: +pnl.toFixed(2) };
  });
}

// ── 常用策略建構器 ────────────────────────────────────────────────────

/**
 * Iron Condor：賣出 OTM Strangle + 買入更外 OTM Strangle（風險有限）
 * @param {object} p
 * @param {number}  p.S         現貨
 * @param {number}  p.T         到期（年）
 * @param {number}  p.r
 * @param {number}  p.sigma
 * @param {number}  p.wingWidth  翼展點數（put/call strike 距離 ATM）
 * @param {number}  p.protWidth  保護翼距（比 wingWidth 更遠）
 * @returns {{ legs, maxProfit, maxLoss, breakevens, greeks }}
 */
export function ironCondor(params) {
  const { S, T, r, sigma } = params;
  const wingWidth = params.wingWidth ?? 100;
  const protWidth = params.protWidth ?? 200;
  const K1 = S - protWidth; // 買入 put（最外）
  const K2 = S - wingWidth; // 賣出 put
  const K3 = S + wingWidth; // 賣出 call
  const K4 = S + protWidth; // 買入 call（最外）

  const p1 = blackScholes({ S, K: K1, T, r, sigma, type: "put" });
  const p2 = blackScholes({ S, K: K2, T, r, sigma, type: "put" });
  const p3 = blackScholes({ S, K: K3, T, r, sigma, type: "call" });
  const p4 = blackScholes({ S, K: K4, T, r, sigma, type: "call" });

  // 淨權利金收入（賣 - 買）
  const netCredit = p2.price - p1.price + (p3.price - p4.price);
  const spread = wingWidth; // K2-K1 = K4-K3

  const legs = [
    { type: "put", K: K1, qty: 1, premium: p1.price, label: "Buy Put" },
    { type: "put", K: K2, qty: -1, premium: p2.price, label: "Sell Put" },
    { type: "call", K: K3, qty: -1, premium: p3.price, label: "Sell Call" },
    { type: "call", K: K4, qty: 1, premium: p4.price, label: "Buy Call" },
  ];

  const greeks = {
    delta: p1.delta - p2.delta - p3.delta + p4.delta,
    gamma: p1.gamma - p2.gamma - p3.gamma + p4.gamma,
    vega: p1.vega - p2.vega - p3.vega + p4.vega,
    theta: p1.theta - p2.theta - p3.theta + p4.theta,
  };

  return {
    legs,
    netCredit: +netCredit.toFixed(2),
    maxProfit: +netCredit.toFixed(2),
    maxLoss: +(spread - netCredit).toFixed(2),
    breakevens: [+(K2 - netCredit).toFixed(1), +(K3 + netCredit).toFixed(1)],
    greeks,
    strikes: { K1, K2, K3, K4 },
  };
}

/**
 * Straddle：同行使價買入 Call + Put（押波動）
 */
export function straddle({ S, T, r, sigma, K = null }) {
  const strike = K ?? Math.round(S / 50) * 50; // ATM
  const call = blackScholes({ S, K: strike, T, r, sigma, type: "call" });
  const put = blackScholes({ S, K: strike, T, r, sigma, type: "put" });
  const totalPremium = call.price + put.price;

  const legs = [
    { type: "call", K: strike, qty: 1, premium: call.price, label: "Buy Call" },
    { type: "put", K: strike, qty: 1, premium: put.price, label: "Buy Put" },
  ];

  return {
    legs,
    totalPremium: +totalPremium.toFixed(2),
    maxLoss: +totalPremium.toFixed(2),
    maxProfit: Infinity, // 無限（理論上）
    breakevens: [+(strike - totalPremium).toFixed(1), +(strike + totalPremium).toFixed(1)],
    greeks: {
      delta: +(call.delta + put.delta).toFixed(4), // ≈ 0 for ATM
      gamma: +(call.gamma + put.gamma).toFixed(6),
      vega: +(call.vega + put.vega).toFixed(4),
      theta: +(call.theta + put.theta).toFixed(4),
    },
    strike,
  };
}

/**
 * Strangle：不同行使價的 OTM Call + OTM Put（成本更低）
 */
export function strangle({ S, T, r, sigma, callStrike = null, putStrike = null, width = 100 }) {
  const Kc = callStrike ?? S + width;
  const Kp = putStrike ?? S - width;
  const call = blackScholes({ S, K: Kc, T, r, sigma, type: "call" });
  const put = blackScholes({ S, K: Kp, T, r, sigma, type: "put" });
  const totalPremium = call.price + put.price;

  return {
    legs: [
      { type: "call", K: Kc, qty: 1, premium: call.price, label: "Buy OTM Call" },
      { type: "put", K: Kp, qty: 1, premium: put.price, label: "Buy OTM Put" },
    ],
    totalPremium: +totalPremium.toFixed(2),
    maxLoss: +totalPremium.toFixed(2),
    breakevens: [+(Kp - totalPremium).toFixed(1), +(Kc + totalPremium).toFixed(1)],
    greeks: {
      delta: +(call.delta + put.delta).toFixed(4),
      gamma: +(call.gamma + put.gamma).toFixed(6),
      vega: +(call.vega + put.vega).toFixed(4),
      theta: +(call.theta + put.theta).toFixed(4),
    },
  };
}

// ── Delta 中性對沖 ────────────────────────────────────────────────────
/**
 * 計算 Delta 對沖所需現貨手數
 * @param {Array}  legs  期權腳位 [{ type, K, qty, sigma, T, r }]
 * @param {number} S     現貨價格
 * @returns {{ portfolioDelta, hedgeQty, hedgeAction }}
 */
export function deltaHedge(legs, S) {
  let portfolioDelta = 0;
  for (const leg of legs) {
    const { delta } = blackScholes({
      S,
      K: leg.K,
      T: leg.T,
      r: leg.r,
      sigma: leg.sigma,
      type: leg.type,
    });
    portfolioDelta += leg.qty * delta;
  }

  const hedgeQty = -portfolioDelta;
  const hedgeAction = hedgeQty > 0 ? "buy" : "sell";

  return {
    portfolioDelta: +portfolioDelta.toFixed(4),
    hedgeQty: +Math.abs(hedgeQty).toFixed(4),
    hedgeAction,
    description: `${hedgeAction.toUpperCase()} ${Math.abs(hedgeQty).toFixed(4)} 單位現貨以達成 Delta 中性`,
  };
}

// ── OptionsStrategy 類（BaseStrategy 風格）───────────────────────────
export class OptionsStrategy {
  /**
   * @param {object} opts
   * @param {string}  opts.name
   * @param {string}  opts.instrument      標的（現貨/期貨）
   * @param {string}  opts.strategyType    'iron_condor'|'straddle'|'strangle'|'custom'
   * @param {number}  opts.r               無風險利率
   * @param {number}  opts.T               到期時間（年）
   * @param {number}  opts.sigma           波動率（若無 IV 計算時用）
   * @param {number}  opts.wingWidth       Iron Condor 翼展
   * @param {number}  opts.protWidth       Iron Condor 保護翼
   * @param {number}  opts.straddelWidth   Strangle 翼展
   * @param {number}  opts.volLookback     計算 HV 的回望根數（預設 20）
   * @param {number}  opts.ivMultiple      進場條件：IV/HV 比值（預設 1.2 = IV 比 HV 高 20%）
   */
  constructor(opts = {}) {
    this.name = opts.name ?? "OptionsStrategy";
    this.instrument = opts.instrument ?? "TX00";
    this.strategyType = opts.strategyType ?? "iron_condor";
    this.r = opts.r ?? 0.02;
    this.T = opts.T ?? 30 / 365;
    this.sigma = opts.sigma ?? 0.2;
    this.wingWidth = opts.wingWidth ?? 100;
    this.protWidth = opts.protWidth ?? 200;
    this.strangleWidth = opts.strangleWidth ?? 100;
    this.volLookback = opts.volLookback ?? 20;
    this.ivMultiple = opts.ivMultiple ?? 1.2;

    this._signals = [];
    this._bars = [];
    this._position = null; // 當前期權組合
  }

  /** 計算歷史波動率（年化） */
  _historicalVol(bars) {
    if (bars.length < 2) {
      return this.sigma;
    }
    const returns = bars
      .slice(-this.volLookback - 1)
      .slice(0, -1)
      .map((b, i) => Math.log(bars.slice(-this.volLookback)[i].close / b.close));
    if (returns.length < 2) {
      return this.sigma;
    }
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance * 252);
  }

  onBar(bar) {
    this._bars.push(bar);
    if (this._bars.length < this.volLookback + 5) {
      return;
    }

    const S = bar.close;
    const hv = this._historicalVol(this._bars);
    const sig = this.sigma > 0 ? this.sigma : hv;

    // 若已有部位，不再開新倉
    if (this._position) {
      return;
    }

    // 進場條件：IV（代入 sigma）> HV * ivMultiple（隱含高估 → 適合賣出波動率）
    const ivPremium = sig / hv;
    if (ivPremium < this.ivMultiple) {
      return;
    }

    let strategy;
    if (this.strategyType === "iron_condor") {
      strategy = ironCondor({
        S,
        T: this.T,
        r: this.r,
        sigma: sig,
        wingWidth: this.wingWidth,
        protWidth: this.protWidth,
      });
    } else if (this.strategyType === "straddle") {
      strategy = straddle({ S, T: this.T, r: this.r, sigma: sig });
    } else if (this.strategyType === "strangle") {
      strategy = strangle({ S, T: this.T, r: this.r, sigma: sig, width: this.strangleWidth });
    } else {
      return;
    }

    this._position = { ...strategy, entryBar: bar, entryS: S, entryHv: hv };

    // 發出摘要信號（紀錄用，非交易下單）
    this._signals.push({
      strategy: this.name,
      instrument: this.instrument,
      direction: "open",
      type: this.strategyType,
      netCredit: strategy.netCredit ?? strategy.totalPremium,
      maxLoss: strategy.maxLoss,
      breakevens: strategy.breakevens,
      greeks: strategy.greeks,
      hv: +hv.toFixed(4),
      ivPremium: +ivPremium.toFixed(2),
      ts: bar.time,
    });
  }

  popSignals() {
    const s = this._signals;
    this._signals = [];
    return s;
  }

  /** 手動平倉當前部位 */
  closePosition(currentBar) {
    if (!this._position) {
      return null;
    }
    const pos = this._position;
    this._position = null;
    return {
      strategy: this.name,
      instrument: this.instrument,
      direction: "close",
      type: this.strategyType,
      duration: this._bars.length - pos.entryBar,
      ts: currentBar?.time,
    };
  }

  status() {
    return {
      name: this.name,
      hasPosition: !!this._position,
      position: this._position
        ? {
            type: this.strategyType,
            entryS: this._position.entryS,
            entryHv: this._position.entryHv,
            breakevens: this._position.breakevens,
            greeks: this._position.greeks,
          }
        : null,
    };
  }
}

// ── 列印工具 ──────────────────────────────────────────────────────────
export function printGreeks(result, label = "") {
  console.log(`\n  ${label || "Option"}`);
  console.log(`  價格: ${result.price}  Delta: ${result.delta}  Gamma: ${result.gamma}`);
  console.log(`  Vega: ${result.vega}   Theta: ${result.theta}  Rho:   ${result.rho}`);
}

export function printIronCondor(ic) {
  console.log("\n  ─── Iron Condor ───────────────────────");
  for (const leg of ic.legs) {
    console.log(`    ${leg.label.padEnd(12)} K=${leg.K}  premium=${leg.premium}`);
  }
  console.log(`  淨收入: ${ic.netCredit}  最大獲利: ${ic.maxProfit}  最大虧損: ${ic.maxLoss}`);
  console.log(`  損益兩平: ${ic.breakevens[0]} / ${ic.breakevens[1]}`);
  console.log(
    `  Greeks → Delta: ${ic.greeks.delta.toFixed(4)}  Gamma: ${ic.greeks.gamma.toFixed(6)}  Vega: ${ic.greeks.vega.toFixed(4)}  Theta: ${ic.greeks.theta.toFixed(4)}`,
  );
}
