// MarkowitzOptimizer.mjs — Markowitz 現代投資組合理論
// 開源參考：
//   Harry Markowitz (1952) "Portfolio Selection"
//   https://github.com/czielinski/portfolioopt
//   https://github.com/nickmccullum/algorithmic-trading-python
//
// 功能：
//   1. 計算共變異數矩陣 (Covariance Matrix)
//   2. 最小變異數組合 (Minimum Variance Portfolio)
//   3. 最大夏普組合   (Maximum Sharpe Ratio Portfolio)
//   4. 有效前沿       (Efficient Frontier) — 蒙地卡羅隨機採樣
//   5. 風險平價       (Risk Parity / Equal Risk Contribution)
//   6. Black-Litterman 觀點調整（基礎版）

// ── 線性代數工具（純 JS，不依賴 numpy）──────────────────────────

/** 矩陣乘法 A(m×k) × B(k×n) → C(m×n) */
function matMul(A, B) {
  const m = A.length,
    n = B[0].length;
  return Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) => A[i].reduce((s, _, l) => s + A[i][l] * B[l][j], 0)),
  );
}

/** 矩陣轉置 */
function transpose(A) {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

/** 向量點積 */
function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

/** 從 returns 矩陣計算共變異數矩陣 (T×N → N×N) */
function covMatrix(returnsMatrix) {
  const T = returnsMatrix.length; // 時間點數
  const N = returnsMatrix[0].length; // 資產數
  const means = Array.from(
    { length: N },
    (_, j) => returnsMatrix.reduce((s, row) => s + row[j], 0) / T,
  );
  const cov = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => {
      const sum = returnsMatrix.reduce(
        (s, row) => s + (row[i] - means[i]) * (row[j] - means[j]),
        0,
      );
      return sum / (T - 1);
    }),
  );
  return { cov, means };
}

/** 簡化 Cholesky 求逆（用於小矩陣 N≤20），Gauss-Jordan */
function invertMatrix(M) {
  const n = M.length;
  const A = M.map((row) => [...row]);
  const I = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[maxRow][col])) {
        maxRow = r;
      }
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [I[col], I[maxRow]] = [I[maxRow], I[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-12) {
      continue;
    } // singular
    for (let j = 0; j < n; j++) {
      A[col][j] /= pivot;
      I[col][j] /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) {
        continue;
      }
      const factor = A[r][col];
      for (let j = 0; j < n; j++) {
        A[r][j] -= factor * A[col][j];
        I[r][j] -= factor * I[col][j];
      }
    }
  }
  return I;
}

/** 投資組合年化報酬、波動率、夏普 */
function portfolioStats(weights, means, cov, annualFactor = 252, riskFreeRate = 0) {
  const ret = dot(weights, means) * annualFactor;
  // σ² = w' Σ w
  const wCov = cov.map((row) => dot(row, weights));
  const variance = dot(weights, wCov);
  const vol = Math.sqrt(variance * annualFactor);
  const sharpe = vol > 0 ? (ret - riskFreeRate) / vol : 0;
  return { ret, vol, sharpe };
}

// ── 蒙地卡羅隨機組合採樣 ────────────────────────────────────────
function randomWeights(n) {
  const w = Array.from({ length: n }, () => Math.random());
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}

function monteCarloFrontier(
  means,
  cov,
  numPortfolios = 5000,
  annualFactor = 252,
  riskFreeRate = 0,
) {
  const N = means.length;
  const portfolios = [];
  let maxSharpe = -Infinity,
    minVol = Infinity;
  let maxSharpePort = null,
    minVolPort = null;

  for (let i = 0; i < numPortfolios; i++) {
    const w = randomWeights(N);
    const { ret, vol, sharpe } = portfolioStats(w, means, cov, annualFactor, riskFreeRate);
    const p = { weights: w, ret, vol, sharpe };
    portfolios.push(p);
    if (sharpe > maxSharpe) {
      maxSharpe = sharpe;
      maxSharpePort = p;
    }
    if (vol < minVol) {
      minVol = vol;
      minVolPort = p;
    }
  }
  return { portfolios, maxSharpePort, minVolPort };
}

// ── 最小化變異數（解析解）───────────────────────────────────────
// 全投 min var: w* = Σ⁻¹ 1 / (1'Σ⁻¹1)
function minVarianceWeights(cov) {
  const N = cov.length;
  const inv = invertMatrix(cov);
  const ones = Array(N).fill(1);
  const invOnes = inv.map((row) => dot(row, ones));
  const scale = dot(ones, invOnes);
  return invOnes.map((v) => v / scale);
}

// ── 風險平價（Equal Risk Contribution）──────────────────────────
// 迭代法（Maillard et al. 2010）
function riskParityWeights(cov, maxIter = 200, tol = 1e-8) {
  const N = cov.length;
  let w = Array(N).fill(1 / N);

  for (let iter = 0; iter < maxIter; iter++) {
    const sigma2 = cov.map((row) => dot(row, w)).reduce((s, v, i) => s + v * w[i], 0);
    const sigma = Math.sqrt(sigma2);
    // Marginal Risk Contribution: MRC_i = (Σw)_i / σ
    const Sw = cov.map((row) => dot(row, w));
    const mrc = Sw.map((v) => v / sigma);
    // Risk Contribution: RC_i = w_i × MRC_i
    const rc = w.map((wi, i) => wi * mrc[i]);
    // Target equal RC = σ/N
    const target = sigma / N;
    // Gradient step
    const wNew = w.map((wi, i) => Math.max(0.001, (wi * target) / rc[i])); // clamp ≥ 0
    const s = wNew.reduce((a, b) => a + b, 0);
    const wNorm = wNew.map((v) => v / s);
    const diff = wNorm.reduce((d, v, i) => d + Math.abs(v - w[i]), 0);
    w = wNorm;
    if (diff < tol) {
      break;
    }
  }
  return w;
}

// ── 主類別 ───────────────────────────────────────────────────────
export class MarkowitzOptimizer {
  /**
   * @param {object} opts
   * @param {string[]} opts.assets        資產名稱陣列
   * @param {number}   opts.annualFactor  年化因子 (252=日K, 52=週K, 12=月K)
   * @param {number}   opts.riskFreeRate  年化無風險利率 (預設 0.02)
   * @param {number}   opts.numSimulations 蒙地卡羅模擬次數
   */
  constructor(opts = {}) {
    this.assets = opts.assets ?? [];
    this.annualFactor = opts.annualFactor ?? 252;
    this.riskFreeRate = opts.riskFreeRate ?? 0.02;
    this.numSimulations = opts.numSimulations ?? 5000;
    this._returnsMatrix = null; // T×N 日報酬矩陣
    this._cov = null;
    this._means = null;
  }

  /**
   * 載入價格矩陣並計算報酬
   * @param {number[][]} priceMatrix  T×N 收盤價矩陣（每欄一個資產）
   */
  loadPrices(priceMatrix) {
    const T = priceMatrix.length;
    const N = priceMatrix[0].length;
    // 計算對數日報酬
    this._returnsMatrix = Array.from({ length: T - 1 }, (_, t) =>
      Array.from({ length: N }, (_, n) => Math.log(priceMatrix[t + 1][n] / priceMatrix[t][n])),
    );
    const { cov, means } = covMatrix(this._returnsMatrix);
    this._cov = cov;
    this._means = means;
    return this;
  }

  /**
   * 直接載入報酬矩陣（T×N）
   */
  loadReturns(returnsMatrix) {
    this._returnsMatrix = returnsMatrix;
    const { cov, means } = covMatrix(returnsMatrix);
    this._cov = cov;
    this._means = means;
    return this;
  }

  /** 最大夏普組合（蒙地卡羅搜尋） */
  maxSharpe() {
    this._checkReady();
    const { maxSharpePort } = monteCarloFrontier(
      this._means,
      this._cov,
      this.numSimulations,
      this.annualFactor,
      this.riskFreeRate,
    );
    return this._wrap("Max Sharpe", maxSharpePort);
  }

  /** 最小變異數組合（解析解） */
  minVariance() {
    this._checkReady();
    const w = minVarianceWeights(this._cov);
    const stats = portfolioStats(w, this._means, this._cov, this.annualFactor, this.riskFreeRate);
    return this._wrap("Min Variance", { weights: w, ...stats });
  }

  /** 風險平價（等風險貢獻） */
  riskParity() {
    this._checkReady();
    const w = riskParityWeights(this._cov);
    const stats = portfolioStats(w, this._means, this._cov, this.annualFactor, this.riskFreeRate);
    return this._wrap("Risk Parity", { weights: w, ...stats });
  }

  /** 等權重基準 */
  equalWeight() {
    this._checkReady();
    const N = this._means.length;
    const w = Array(N).fill(1 / N);
    const stats = portfolioStats(w, this._means, this._cov, this.annualFactor, this.riskFreeRate);
    return this._wrap("Equal Weight", { weights: w, ...stats });
  }

  /** 有效前沿（Monte Carlo 散點） */
  efficientFrontier() {
    this._checkReady();
    const { portfolios, maxSharpePort, minVolPort } = monteCarloFrontier(
      this._means,
      this._cov,
      this.numSimulations,
      this.annualFactor,
      this.riskFreeRate,
    );
    return {
      portfolios: portfolios.map((p) => ({ ret: p.ret, vol: p.vol, sharpe: p.sharpe })),
      maxSharpe: this._wrap("Max Sharpe", maxSharpePort),
      minVol: this._wrap("Min Vol", minVolPort),
    };
  }

  /**
   * Black-Litterman 觀點調整（基礎版）
   * @param {object[]} views  [{ assets: ['BTC','ETH'], returns: 0.10, confidence: 0.5 }]
   */
  blackLitterman(views = []) {
    this._checkReady();
    const N = this._means.length;
    const tau = 0.05; // 縮放因子

    // 市場均衡報酬（逆向工程 CAPM）
    const eqW = Array(N).fill(1 / N);
    const lambda = this.riskFreeRate + 0.5; // 市場風險溢酬
    const pi = this._cov.map((row) => dot(row, eqW) * lambda);

    if (views.length === 0) {
      // 無觀點 → 回傳市場均衡組合
      const stats = portfolioStats(
        eqW,
        this._means,
        this._cov,
        this.annualFactor,
        this.riskFreeRate,
      );
      return this._wrap("Black-Litterman (無觀點)", { weights: eqW, ...stats });
    }

    // 建立 P（觀點矩陣）和 Q（觀點報酬）
    const K = views.length;
    const P = Array.from({ length: K }, (_, i) => {
      const row = Array(N).fill(0);
      const v = views[i];
      if (v.assets) {
        for (const a of v.assets) {
          const idx = this.assets.indexOf(a);
          if (idx >= 0) {
            row[idx] = 1 / v.assets.length;
          }
        }
      }
      return row;
    });
    const Q = views.map((v) => v.returns ?? 0);
    const conf = views.map((v) => v.confidence ?? 0.5);

    // Ω = 對角信心矩陣（1/confidence 越高=越不確定）
    const omega = Array.from({ length: K }, (_, i) =>
      Array.from({ length: K }, (_, j) => (i === j ? ((1 - conf[i]) / conf[i]) * tau : 0)),
    );

    // BL 公式：μ_BL = [(τΣ)⁻¹ + P'Ω⁻¹P]⁻¹ [(τΣ)⁻¹π + P'Ω⁻¹Q]
    // 簡化實作（tau 較小時近似 μ_BL ≈ π + τΣP'(PτΣP'+Ω)⁻¹(Q-Pπ)）
    const tauCov = this._cov.map((row) => row.map((v) => v * tau));
    const PtauCov = matMul(P, tauCov); // K×N
    const PtauCovPt = matMul(PtauCov, transpose(P)); // K×K
    const M = PtauCovPt.map((row, i) => row.map((v, j) => v + omega[i][j]));
    const Minv = invertMatrix(M);

    // Q - P π
    const Ppi = P.map((row) => dot(row, pi));
    const QmPpi = Q.map((q, i) => q - Ppi[i]);

    // τΣP'M⁻¹(Q-Pπ)
    const MInvDiff = Minv.map((row) => dot(row, QmPpi)); // K
    const PtMInvDiff = transpose(P).map((row) => dot(row, MInvDiff)); // N
    const tCovAdj = tauCov.map((row) => dot(row, PtMInvDiff)); // N

    const muBL = pi.map((v, i) => v + tCovAdj[i]);

    // 以 BL 期望報酬重新最佳化（最大夏普）
    const { maxSharpePort } = monteCarloFrontier(
      muBL,
      this._cov,
      this.numSimulations,
      this.annualFactor,
      this.riskFreeRate,
    );
    const result = this._wrap("Black-Litterman", maxSharpePort);
    result.muBL = muBL;
    result.views = views;
    return result;
  }

  // ── 比較所有方法 ─────────────────────────────────────────────
  compareAll(blViews = []) {
    return {
      maxSharpe: this.maxSharpe(),
      minVariance: this.minVariance(),
      riskParity: this.riskParity(),
      equalWeight: this.equalWeight(),
      blackLitterman: blViews.length ? this.blackLitterman(blViews) : null,
    };
  }

  // ── 內部 ─────────────────────────────────────────────────────
  _checkReady() {
    if (!this._cov) {
      throw new Error("請先呼叫 loadPrices() 或 loadReturns()");
    }
  }

  _wrap(name, port) {
    const weights = port?.weights ?? [];
    return {
      name,
      weights: this.assets.length
        ? Object.fromEntries(this.assets.map((a, i) => [a, +(weights[i] ?? 0).toFixed(4)]))
        : weights.map((w) => +w.toFixed(4)),
      annualReturn: +((port?.ret ?? 0) * 100).toFixed(2),
      annualVol: +((port?.vol ?? 0) * 100).toFixed(2),
      sharpe: +(port?.sharpe ?? 0).toFixed(3),
    };
  }
}

// ── 結果報表 ──────────────────────────────────────────────────────
export function printPortfolio(result, title = "") {
  const t = title || result.name;
  console.log(`\n  [${t}]`);
  console.log(
    `    年化報酬: ${result.annualReturn}%  波動率: ${result.annualVol}%  夏普: ${result.sharpe}`,
  );
  console.log("    配置比例:");
  const weights = result.weights;
  if (typeof weights === "object" && !Array.isArray(weights)) {
    for (const [asset, w] of Object.entries(weights)) {
      const bar = "█".repeat(Math.max(0, Math.round(w * 30)));
      console.log(`      ${asset.padEnd(12)} ${(w * 100).toFixed(1).padStart(5)}%  ${bar}`);
    }
  }
}

export function printComparison(results) {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Markowitz 投資組合優化比較");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(
    `  ${"方法".padEnd(20)} ${"年化報酬%".padStart(10)} ${"波動率%".padStart(9)} ${"夏普".padStart(8)}`,
  );
  console.log("──────────────────────────────────────────────────────────────");
  for (const r of Object.values(results)) {
    if (!r) {
      continue;
    }
    console.log(
      `  ${r.name.padEnd(20)} ${String(r.annualReturn).padStart(10)} ${String(r.annualVol).padStart(9)} ${String(r.sharpe).padStart(8)}`,
    );
  }
  console.log("══════════════════════════════════════════════════════════════\n");
}
