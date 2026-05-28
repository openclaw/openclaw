// CorrelationMonitor.mjs — 跨策略相關性風控
// 解決問題：多策略同時持同向部位時總曝險被低估
//
// 功能：
//   1. 即時計算各策略報酬序列的相關係數矩陣
//   2. 當新訊號與現有部位高度相關時發出警告或降低倉量
//   3. 計算整體組合的有效分散度（Effective N）
//   4. 偵測策略群聚（多策略在同一時間同方向進場）

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ss = require("simple-statistics");

// ── 相關係數計算 ──────────────────────────────────────────────────
function pearsonCorr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) {
    return 0;
  }
  const xi = x.slice(-n),
    yi = y.slice(-n);
  const mx = ss.mean(xi),
    my = ss.mean(yi);
  const num = xi.reduce((s, v, i) => s + (v - mx) * (yi[i] - my), 0);
  const dx = Math.sqrt(xi.reduce((s, v) => s + (v - mx) ** 2, 0));
  const dy = Math.sqrt(yi.reduce((s, v) => s + (v - my) ** 2, 0));
  return dx * dy < 1e-10 ? 0 : num / (dx * dy);
}

export class CorrelationMonitor {
  /**
   * @param {object} opts
   * @param {number}  opts.lookback         計算相關性的回望 K 棒數（預設 60）
   * @param {number}  opts.highCorrThresh   高相關警告閾值（預設 0.7）
   * @param {number}  opts.blockCorrThresh  攔截閾值（預設 0.9）
   * @param {number}  opts.qtyScaleFactor   高相關時 qty 縮減比例（預設 0.5）
   * @param {number}  opts.clusterWindow    群聚偵測時間窗口 ms（預設 30000 = 30秒）
   * @param {number}  opts.clusterLimit     同向訊號數量上限（預設 3）
   */
  constructor(opts = {}) {
    this.lookback = opts.lookback ?? 60;
    this.highCorrThresh = opts.highCorrThresh ?? 0.7;
    this.blockCorrThresh = opts.blockCorrThresh ?? 0.9;
    this.qtyScaleFactor = opts.qtyScaleFactor ?? 0.5;
    this.clusterWindow = opts.clusterWindow ?? 30_000;
    this.clusterLimit = opts.clusterLimit ?? 3;

    // strategyName → 近期報酬陣列
    this._returns = new Map();
    // strategyName → 當前方向 ('long'|'short'|null)
    this._directions = new Map();
    // 最近訊號時間戳（用於群聚偵測）
    this._recentSignals = [];
  }

  // ── 更新策略報酬（每根 K 棒後呼叫）──────────────────────────
  updateReturn(strategyName, pnl) {
    if (!this._returns.has(strategyName)) {
      this._returns.set(strategyName, []);
    }
    const arr = this._returns.get(strategyName);
    arr.push(pnl);
    if (arr.length > this.lookback) {
      arr.shift();
    }
  }

  // ── 訊號檢查：是否允許發出？──────────────────────────────────
  /**
   * @param {object} signal   { strategy, direction, instrument, qty }
   * @returns {{ ok: boolean, reason: string, scaledQty: number|null }}
   */
  check(signal) {
    const { strategy, direction, qty = 1 } = signal;
    const isLong = direction === "buy";

    // 1. 群聚偵測：同窗口內同向訊號過多
    const now = Date.now();
    this._recentSignals = this._recentSignals.filter((s) => now - s.ts < this.clusterWindow);
    const sameDir = this._recentSignals.filter((s) =>
      isLong ? s.direction === "buy" : s.direction === "sell",
    );

    if (sameDir.length >= this.clusterLimit) {
      return {
        ok: false,
        reason: `⚠️  群聚偵測: ${this.clusterWindow / 1000}s 內已有 ${sameDir.length} 個同向訊號`,
        scaledQty: null,
      };
    }

    // 2. 相關性檢查：與現有部位高相關？
    const myReturns = this._returns.get(strategy) ?? [];
    let maxCorr = 0;
    let maxCorrStrat = "";

    for (const [name, returns] of this._returns) {
      if (name === strategy) {
        continue;
      }
      const dir = this._directions.get(name);
      if (!dir) {
        continue;
      }

      // 只有相同方向才計算相關性（反向不需要限制）
      const sameDirection = (isLong && dir === "long") || (!isLong && dir === "short");
      if (!sameDirection) {
        continue;
      }

      const corr = Math.abs(pearsonCorr(myReturns, returns));
      if (corr > maxCorr) {
        maxCorr = corr;
        maxCorrStrat = name;
      }
    }

    // 高相關攔截
    if (maxCorr >= this.blockCorrThresh) {
      return {
        ok: false,
        reason: `⚠️  高相關攔截: ${strategy} 與 ${maxCorrStrat} 相關性 ${maxCorr.toFixed(2)} ≥ ${this.blockCorrThresh}`,
        scaledQty: null,
      };
    }

    // 高相關降倉
    let scaledQty = qty;
    if (maxCorr >= this.highCorrThresh) {
      scaledQty = Math.max(1, Math.floor(qty * this.qtyScaleFactor));
      // 記錄訊號（降倉通過）
      this._recentSignals.push({ strategy, direction, ts: now });
      this._directions.set(strategy, isLong ? "long" : "short");
      return {
        ok: true,
        reason: `⚠️  相關性 ${maxCorr.toFixed(2)} 降倉 ${qty}→${scaledQty}`,
        scaledQty,
      };
    }

    // 正常通過
    this._recentSignals.push({ strategy, direction, ts: now });
    this._directions.set(strategy, isLong ? "long" : "short");
    return { ok: true, reason: "pass", scaledQty: qty };
  }

  // ── 平倉時清除方向 ────────────────────────────────────────────
  onClose(strategyName) {
    this._directions.delete(strategyName);
  }

  // ── 相關矩陣報告 ─────────────────────────────────────────────
  getCorrelationMatrix() {
    const names = [...this._returns.keys()];
    const matrix = {};
    for (const a of names) {
      matrix[a] = {};
      for (const b of names) {
        const corr = pearsonCorr(this._returns.get(a) ?? [], this._returns.get(b) ?? []);
        matrix[a][b] = +corr.toFixed(3);
      }
    }
    return matrix;
  }

  /** 有效分散度：Effective N = 1 / Σ(w²)，越高代表越分散 */
  getEffectiveN() {
    const names = [...this._returns.keys()];
    if (names.length < 2) {
      return names.length;
    }
    const n = names.length;
    const w = 1 / n; // 等權
    const mat = this.getCorrelationMatrix();
    // Portfolio variance (equal weight)
    let portVar = 0;
    for (const a of names) {
      for (const b of names) {
        portVar += w * w * (mat[a]?.[b] ?? 0);
      }
    }
    // Effective N = 1 / portVar (normalized)
    return portVar > 0 ? +(1 / portVar / n).toFixed(2) : n;
  }

  printReport() {
    const mat = this.getCorrelationMatrix();
    const names = Object.keys(mat);
    if (names.length < 2) {
      console.log("[CorrelationMonitor] 策略數不足");
      return;
    }

    console.log("\n  相關係數矩陣:");
    const header =
      "                ".padEnd(18) + names.map((n) => n.slice(0, 8).padStart(10)).join("");
    console.log("  " + header);
    for (const a of names) {
      const row = names
        .map((b) => {
          const c = mat[a][b];
          const str = c.toFixed(2).padStart(10);
          return Math.abs(c) >= 0.7 && a !== b ? `\x1b[33m${str}\x1b[0m` : str;
        })
        .join("");
      console.log(`  ${a.slice(0, 16).padEnd(18)}${row}`);
    }
    console.log(`\n  有效分散度 Effective N = ${this.getEffectiveN()} / ${names.length}`);
  }
}
