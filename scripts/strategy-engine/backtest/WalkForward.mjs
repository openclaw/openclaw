// WalkForward.mjs — Walk-Forward 優化框架
// 防止過度擬合 (Overfitting)，通過滾動窗口驗證策略穩健性
// 移植自: https://github.com/kernc/backtesting.py/blob/master/backtesting/backtesting.py
//
// 方法：
//   1. 將資料分為 n 個訓練窗口 + 測試窗口
//   2. 在訓練集上窮舉參數組合，找最佳參數
//   3. 用最佳參數在緊鄰的測試集上驗證
//   4. 滾動前進，重複步驟
//   5. 評估 Walk-Forward Efficiency (WFE) = OOS Sharpe / IS Sharpe
//
// 支援：
//   網格搜尋 (Grid Search)
//   自適應窗口 (anchored / rolling)

import { Backtester } from "./Backtester.mjs";

// ── 工具：生成參數組合 ────────────────────────────────────────────
export function gridSearch(paramGrid) {
  // paramGrid: { period: [10,20,30], fast: [5,10], slow: [20,50] }
  const keys = Object.keys(paramGrid);
  const values = keys.map((k) => paramGrid[k]);
  const combos = [];

  function recurse(idx, current) {
    if (idx === keys.length) {
      combos.push({ ...current });
      return;
    }
    for (const v of values[idx]) {
      current[keys[idx]] = v;
      recurse(idx + 1, current);
    }
  }
  recurse(0, {});
  return combos;
}

// ── Walk-Forward 主類別 ───────────────────────────────────────────
export class WalkForward {
  /**
   * @param {object} opts
   * @param {number} opts.trainBars     訓練窗口 K 棒數 (預設 300)
   * @param {number} opts.testBars      測試窗口 K 棒數 (預設 100)
   * @param {boolean} opts.anchored     true=錨定起點擴展, false=滾動窗口
   * @param {string}  opts.metric       優化指標 'sharpe'|'return'|'sortino'|'calmar' (預設 'sharpe')
   * @param {object}  opts.costModel    { commissionPct, slippagePct }
   */
  constructor(opts = {}) {
    this.trainBars = opts.trainBars ?? 300;
    this.testBars = opts.testBars ?? 100;
    this.anchored = opts.anchored ?? false;
    this.metric = opts.metric ?? "sharpe";
    this.costModel = opts.costModel ?? {};
    this.bt = new Backtester(this.costModel);
  }

  /**
   * 執行 Walk-Forward 優化
   * @param {Function}  StratClass   策略類別 constructor
   * @param {object}    baseConfig   基礎設定 (name, instrument, broker...)
   * @param {object[]}  allBars      完整歷史 K 棒
   * @param {object}    paramGrid    { paramName: [v1, v2, v3], ... }
   * @returns {WalkForwardResult}
   */
  run(StratClass, baseConfig, allBars, paramGrid) {
    const combos = gridSearch(paramGrid);
    const folds = [];
    let cursor = 0;

    // 計算可用 fold 數量
    const totalNeeded = this.trainBars + this.testBars;
    if (allBars.length < totalNeeded) {
      throw new Error(`資料不足: 需要 ${totalNeeded} 根，實際 ${allBars.length} 根`);
    }

    while (cursor + this.trainBars + this.testBars <= allBars.length) {
      const trainStart = this.anchored ? 0 : cursor;
      const trainEnd = cursor + this.trainBars;
      const testEnd = trainEnd + this.testBars;

      const trainBars = allBars.slice(trainStart, trainEnd);
      const testBars = allBars.slice(trainEnd, testEnd);

      // ── IS 最佳化：網格搜尋 ───────────────
      let bestParams = combos[0];
      let bestScore = -Infinity;

      for (const params of combos) {
        const cfg = { ...baseConfig, params };
        const strat = new StratClass(cfg);
        const res = this.bt.run(strat, trainBars);
        const score = this._score(res);
        if (score > bestScore) {
          bestScore = score;
          bestParams = params;
        }
      }

      // ── OOS 驗證：使用最佳參數 ───────────
      const oosStrat = new StratClass({ ...baseConfig, params: bestParams });
      const oosResult = this.bt.run(oosStrat, testBars);
      const oosScore = this._score(oosResult);

      folds.push({
        foldIdx: folds.length,
        trainRange: [trainStart, trainEnd - 1],
        testRange: [trainEnd, testEnd - 1],
        bestParams,
        isScore: bestScore,
        oosScore,
        oosResult,
      });

      cursor += this.testBars; // 前進一個測試窗口
    }

    return this._summarize(folds);
  }

  _score(result) {
    // Backtester result uses nested structure: result.risk.sharpe, result.capital.returnPct
    const risk = result.risk ?? result;
    const capital = result.capital ?? result;
    switch (this.metric) {
      case "return":
        return capital.returnPct ?? risk.returnPct ?? -Infinity;
      case "sortino":
        return risk.sortino ?? -Infinity;
      case "calmar":
        return risk.calmar ?? -Infinity;
      default:
        return risk.sharpe ?? -Infinity; // 'sharpe'
    }
  }

  _summarize(folds) {
    const isScores = folds.map((f) => f.isScore).filter(isFinite);
    const oosScores = folds.map((f) => f.oosScore).filter(isFinite);

    const avgIs = isScores.length ? isScores.reduce((s, v) => s + v, 0) / isScores.length : 0;
    const avgOos = oosScores.length ? oosScores.reduce((s, v) => s + v, 0) / oosScores.length : 0;

    // Walk-Forward Efficiency = OOS / IS (越接近 1 越好)
    const wfe = avgIs !== 0 ? avgOos / avgIs : 0;

    // 累計 OOS PnL
    const totalOosPnl = folds.reduce((s, f) => s + (f.oosResult?.totalPnl ?? 0), 0);
    const totalOosReturn = folds.reduce((s, f) => s + (f.oosResult?.returnPct ?? 0), 0);

    // 最常出現的最佳參數（穩健性指標）
    const paramFreq = {};
    for (const f of folds) {
      const key = JSON.stringify(f.bestParams);
      paramFreq[key] = (paramFreq[key] ?? 0) + 1;
    }
    const robustParams = JSON.parse(
      Object.entries(paramFreq).toSorted((a, b) => b[1] - a[1])[0][0],
    );

    return {
      folds,
      avgIsScore: +avgIs.toFixed(4),
      avgOosScore: +avgOos.toFixed(4),
      wfe: +wfe.toFixed(4), // Walk-Forward Efficiency
      totalOosPnl: +totalOosPnl.toFixed(2),
      totalOosReturn: +totalOosReturn.toFixed(2),
      robustParams, // 最穩健的參數組合
      metric: this.metric,
    };
  }
}

// ── 結果印出 ──────────────────────────────────────────────────────
export function printWalkForward(result) {
  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  Walk-Forward 優化結果 (metric: ${result.metric})`);
  console.log("══════════════════════════════════════════════════════");
  console.log(`  Folds 數量      : ${result.folds.length}`);
  console.log(`  平均 IS 分數    : ${result.avgIsScore}`);
  console.log(`  平均 OOS 分數   : ${result.avgOosScore}`);
  console.log(
    `  WFE 效率        : ${(result.wfe * 100).toFixed(1)}% ${
      result.wfe >= 0.7 ? "✅ 穩健" : result.wfe >= 0.5 ? "⚠️ 尚可" : "❌ 過擬合"
    }`,
  );
  console.log(`  OOS 累計報酬    : ${result.totalOosReturn.toFixed(2)}%`);
  console.log(`  OOS 累計損益    : ${result.totalOosPnl >= 0 ? "+" : ""}${result.totalOosPnl}`);
  console.log(`  最穩健參數      : ${JSON.stringify(result.robustParams)}`);
  console.log("");
  console.log("  Fold 明細:");
  console.log("  ┌──────┬──────────┬──────────┬──────────────────────────┐");
  console.log("  │ Fold │  IS分數  │ OOS分數  │ 最佳參數                 │");
  console.log("  ├──────┼──────────┼──────────┼──────────────────────────┤");
  for (const f of result.folds) {
    const params = JSON.stringify(f.bestParams).slice(0, 24).padEnd(24);
    const isFmt = Number.isFinite(f.isScore) ? f.isScore.toFixed(2) : " N/A";
    const oosFmt = Number.isFinite(f.oosScore) ? f.oosScore.toFixed(2) : " N/A";
    console.log(
      `  │ ${String(f.foldIdx).padStart(4)} │ ${isFmt.padStart(8)} │ ${oosFmt.padStart(8)} │ ${params} │`,
    );
  }
  console.log("  └──────┴──────────┴──────────┴──────────────────────────┘");
  console.log("══════════════════════════════════════════════════════\n");
}

// ── Monte Carlo 模擬（副功能）────────────────────────────────────
/**
 * Monte Carlo 資金曲線模擬
 * @param {object} result    Backtester.run() 結果
 * @param {number} numPaths  模擬路徑數 (預設 1000)
 * @param {number} horizon   往前模擬根數 (預設 100)
 * @returns {{ paths, worstCaseDrawdown, p5Return, p50Return, p95Return }}
 */
export function monteCarlo(result, numPaths = 1000, horizon = 100) {
  // tradeLog contains all open+close entries; filter for close trades with pnl
  const trades = (result.tradeLog ?? result.trades ?? []).filter((t) => t.pnl != null);
  if (trades.length < 10) {
    return null;
  }

  const pnls = trades.map((t) => t.pnl ?? 0);
  const n = pnls.length;
  const paths = [];

  for (let p = 0; p < numPaths; p++) {
    let equity = result.initialEquity ?? 1_000_000;
    const curve = [equity];
    for (let i = 0; i < horizon; i++) {
      // 隨機重抽歷史交易損益
      const sample = pnls[Math.floor(Math.random() * n)];
      equity += sample;
      curve.push(equity);
    }
    paths.push(curve);
  }

  // 最終資金分佈
  const finalEquities = paths.map((p) => p[p.length - 1]);
  finalEquities.sort((a, b) => a - b);

  const initEq = result.capital?.initial ?? result.initialEquity ?? 1_000_000;
  const toReturn = (eq) => (((eq - initEq) / initEq) * 100).toFixed(2);

  // 最大回撤分佈
  const maxDDs = paths.map((path) => {
    let peak = path[0],
      maxDD = 0;
    for (const eq of path) {
      if (eq > peak) {
        peak = eq;
      }
      const dd = (peak - eq) / peak;
      if (dd > maxDD) {
        maxDD = dd;
      }
    }
    return maxDD;
  });
  maxDDs.sort((a, b) => a - b);

  return {
    numPaths,
    horizon,
    p5Return: toReturn(finalEquities[Math.floor(numPaths * 0.05)]),
    p50Return: toReturn(finalEquities[Math.floor(numPaths * 0.5)]),
    p95Return: toReturn(finalEquities[Math.floor(numPaths * 0.95)]),
    worstCaseDrawdown: (maxDDs[Math.floor(numPaths * 0.95)] * 100).toFixed(2) + "%",
    paths: paths.slice(0, 10), // 只回傳前 10 條路徑（節省記憶體）
  };
}

export function printMonteCarlo(mc) {
  if (!mc) {
    console.log("[Monte Carlo] 交易筆數不足（需要 ≥ 10 筆）");
    return;
  }
  console.log(`\n  Monte Carlo 模擬 (${mc.numPaths} 路徑 × ${mc.horizon} 步):`);
  console.log(`    P5  報酬率 : ${mc.p5Return}%  (最差情境)`);
  console.log(`    P50 報酬率 : ${mc.p50Return}% (中位數)`);
  console.log(`    P95 報酬率 : ${mc.p95Return}% (最佳情境)`);
  console.log(`    95% 最大回撤: ${mc.worstCaseDrawdown}`);
}
