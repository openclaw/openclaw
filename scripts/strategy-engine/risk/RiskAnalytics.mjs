// RiskAnalytics.mjs — 風險分析：VaR / CVaR / 壓力測試
// 功能：
//   1. Historical VaR（歷史模擬法）
//   2. Parametric VaR（常態分佈假設）
//   3. CVaR / Expected Shortfall (ES)
//   4. 壓力測試情境（2008金融海嘯、2020 COVID、Flash Crash 等）
//   5. 回撤統計（最大、平均、持續時間）
//   6. 夏普/索提諾/卡瑪比率
//   7. 整合回測結果 → 一鍵出報告

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ss = require("simple-statistics");

// ── 歷史 VaR ─────────────────────────────────────────────────────────
/**
 * 歷史模擬法 VaR
 * @param {number[]} returns   日報酬率序列（小數，如 0.01 = 1%）
 * @param {number}   confidence 信心水準（如 0.95, 0.99）
 * @param {number}   capital    資本（用於換算金額）
 * @returns {{ varPct, varAmount, cvarPct, cvarAmount }}
 */
export function historicalVaR(returns, confidence = 0.95, capital = 1_000_000) {
  if (returns.length < 10) {
    return { varPct: 0, varAmount: 0, cvarPct: 0, cvarAmount: 0 };
  }

  const sorted = [...returns].toSorted((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  const varPct = -(sorted[idx] ?? 0); // VaR 為正數（損失）

  // CVaR = 超過 VaR 的平均損失
  const tail = sorted.slice(0, idx + 1);
  const cvarPct = tail.length > 0 ? -ss.mean(tail) : varPct;

  return {
    varPct: +varPct.toFixed(4),
    varAmount: +(varPct * capital).toFixed(0),
    cvarPct: +cvarPct.toFixed(4),
    cvarAmount: +(cvarPct * capital).toFixed(0),
  };
}

// ── 參數化 VaR（常態假設）────────────────────────────────────────────
/**
 * @param {number[]} returns
 * @param {number}   confidence
 * @param {number}   capital
 * @param {number}   horizon    持有天數（預設1）
 */
export function parametricVaR(returns, confidence = 0.95, capital = 1_000_000, horizon = 1) {
  if (returns.length < 10) {
    return { varPct: 0, varAmount: 0, cvarPct: 0, cvarAmount: 0 };
  }

  const mu = ss.mean(returns);
  const sigma = ss.standardDeviation(returns);

  // z-score for confidence level (one-tailed)
  const zTable = { 0.9: 1.2816, 0.95: 1.6449, 0.99: 2.3263, 0.999: 3.0902 };
  const z = zTable[confidence] ?? 1.6449;

  // Square-root-of-time scaling
  const sqrtH = Math.sqrt(horizon);
  const varPct = -(mu * horizon - z * sigma * sqrtH); // 損失為正

  // CVaR for normal: μ - σ * φ(z) / (1-α)
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cvarPct = -(mu * horizon - ((sigma * phi) / (1 - confidence)) * sqrtH);

  return {
    varPct: +Math.max(0, varPct).toFixed(4),
    varAmount: +(Math.max(0, varPct) * capital).toFixed(0),
    cvarPct: +Math.max(0, cvarPct).toFixed(4),
    cvarAmount: +(Math.max(0, cvarPct) * capital).toFixed(0),
    mu: +mu.toFixed(5),
    sigma: +sigma.toFixed(5),
  };
}

// ── 壓力測試情境 ──────────────────────────────────────────────────────
/** 預設壓力測試情境（歷史最惡極端事件） */
export const STRESS_SCENARIOS = {
  "2008金融海嘯（最壞單月）": {
    description: "Lehman 倒閉月（2008-09）",
    shockPct: -0.3, // -30%
    volMultiple: 4.0,
  },
  "2020 COVID暴跌（最壞單週）": {
    description: "2020-03-16 全球熔斷",
    shockPct: -0.15,
    volMultiple: 3.0,
  },
  "2010 Flash Crash": {
    description: "2010-05-06 道瓊瞬間跌 9%",
    shockPct: -0.09,
    volMultiple: 2.0,
  },
  "2022升息衝擊": {
    description: "Fed 連續升息，Nasdaq -35%",
    shockPct: -0.2,
    volMultiple: 2.5,
  },
  "台股熔斷（假設 -10%）": {
    description: "漲跌幅 10% 限制最壞情況",
    shockPct: -0.1,
    volMultiple: 2.0,
  },
  "溫和修正（-5%）": {
    description: "一般性技術修正",
    shockPct: -0.05,
    volMultiple: 1.5,
  },
  "暴漲情境（+10%）": {
    description: "重大利多，空頭最壞情況",
    shockPct: 0.1,
    volMultiple: 1.5,
  },
};

/**
 * 壓力測試：對當前部位套用情境衝擊
 * @param {object} portfolio   { positions: [{inst, qty, avgPrice, pointValue}], capital }
 * @param {object} scenarios   情境 map（可用 STRESS_SCENARIOS）
 * @param {number} currentPrice 當前市價（套用 shockPct 計算損失）
 * @returns {Array} 各情境 → { scenario, shock, loss, lossCapitalPct }
 */
export function stressTest(portfolio, scenarios = STRESS_SCENARIOS, currentPrice = 18000) {
  const results = [];

  for (const [name, sc] of Object.entries(scenarios)) {
    const shockPrice = currentPrice * (1 + sc.shockPct);
    let totalLoss = 0;

    for (const pos of portfolio.positions ?? []) {
      const pv = pos.pointValue ?? 200;
      const delta = (shockPrice - currentPrice) * pos.qty * pv;
      totalLoss += delta;
    }

    const capPct = portfolio.capital > 0 ? totalLoss / portfolio.capital : 0;

    results.push({
      scenario: name,
      description: sc.description,
      shockPct: +(sc.shockPct * 100).toFixed(1),
      shockPrice: +shockPrice.toFixed(0),
      loss: +totalLoss.toFixed(0),
      lossCapitalPct: +(capPct * 100).toFixed(2),
      severity: Math.abs(capPct) < 0.02 ? "低" : Math.abs(capPct) < 0.05 ? "中" : "高",
    });
  }

  return results.toSorted((a, b) => a.loss - b.loss); // 由最惡排列
}

// ── 回撤統計 ──────────────────────────────────────────────────────────
/**
 * 詳細回撤分析
 * @param {number[]} equityCurve
 * @returns {{ maxDrawdown, maxDrawdownPct, avgDrawdown, avgDrawdownPct, drawdownPeriods }}
 */
export function drawdownAnalysis(equityCurve) {
  if (equityCurve.length < 2) {
    return { maxDrawdown: 0, maxDrawdownPct: 0, drawdownPeriods: [] };
  }

  const periods = [];
  let peak = equityCurve[0];
  let peakIdx = 0;
  let inDD = false;
  let ddStart = 0;
  let ddPeak = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    const e = equityCurve[i];
    if (e > peak) {
      if (inDD) {
        // 回撤結束（recovery）
        periods.push({
          start: ddStart,
          trough: equityCurve.indexOf(Math.min(...equityCurve.slice(ddStart, i)), ddStart),
          end: i,
          peak: ddPeak,
          trough_v: Math.min(...equityCurve.slice(ddStart, i)),
          drawdown: ddPeak - Math.min(...equityCurve.slice(ddStart, i)),
          duration: i - ddStart,
        });
        inDD = false;
      }
      peak = e;
      peakIdx = i;
    } else if (e < peak) {
      if (!inDD) {
        inDD = true;
        ddStart = peakIdx;
        ddPeak = peak;
      }
    }
  }

  // 未恢復的回撤
  if (inDD) {
    periods.push({
      start: ddStart,
      trough: equityCurve.indexOf(Math.min(...equityCurve.slice(ddStart))),
      end: null,
      peak: ddPeak,
      trough_v: Math.min(...equityCurve.slice(ddStart)),
      drawdown: ddPeak - Math.min(...equityCurve.slice(ddStart)),
      duration: equityCurve.length - ddStart,
    });
  }

  const maxDD = periods.length > 0 ? Math.max(...periods.map((p) => p.drawdown)) : 0;
  const maxDDPct = equityCurve[0] > 0 ? maxDD / equityCurve[0] : 0;
  const avgDD = periods.length > 0 ? ss.mean(periods.map((p) => p.drawdown)) : 0;
  const avgDDPct = equityCurve[0] > 0 ? avgDD / equityCurve[0] : 0;

  return {
    maxDrawdown: +maxDD.toFixed(0),
    maxDrawdownPct: +(maxDDPct * 100).toFixed(2),
    avgDrawdown: +avgDD.toFixed(0),
    avgDrawdownPct: +(avgDDPct * 100).toFixed(2),
    drawdownCount: periods.length,
    drawdownPeriods: periods.map((p) => ({
      start: p.start,
      trough: p.trough,
      end: p.end,
      peak: p.peak,
      trough_v: p.trough_v,
      drawdown: p.drawdown,
      duration: p.duration,
      drawdownPct: +((p.drawdown / (p.peak || 1)) * 100).toFixed(2),
    })),
  };
}

// ── 績效比率 ──────────────────────────────────────────────────────────
/**
 * 計算多個績效比率
 * @param {number[]} returns      日報酬率序列
 * @param {number}   annualFactor 年化因子（252）
 * @param {number}   riskFreeRate 年化無風險利率（小數）
 * @param {number[]} equityCurve  淨值序列（用於 Calmar）
 * @returns {{ sharpe, sortino, calmar, omega, informationRatio }}
 */
export function performanceRatios(
  returns,
  annualFactor = 252,
  riskFreeRate = 0.02,
  equityCurve = [],
) {
  if (returns.length < 5) {
    return { sharpe: 0, sortino: 0, calmar: 0 };
  }

  const rfDaily = riskFreeRate / annualFactor;
  const excess = returns.map((r) => r - rfDaily);
  const meanExc = ss.mean(excess);
  const stdAll = ss.standardDeviation(returns) || 1e-10;

  // Sharpe
  const sharpe = (meanExc / stdAll) * Math.sqrt(annualFactor);

  // Sortino（只用負報酬標準差）
  const negRets = returns.filter((r) => r < rfDaily);
  const downDev =
    negRets.length > 1 ? Math.sqrt(ss.mean(negRets.map((r) => (r - rfDaily) ** 2))) : stdAll;
  const sortino = (meanExc / downDev) * Math.sqrt(annualFactor);

  // Calmar = 年化報酬 / 最大回撤
  const annRet = ss.mean(returns) * annualFactor;
  let calmar = 0;
  if (equityCurve.length > 1) {
    const { maxDrawdownPct } = drawdownAnalysis(equityCurve);
    calmar = maxDrawdownPct > 0 ? annRet / (maxDrawdownPct / 100) : 0;
  }

  // Omega = sum(positive excess) / sum(|negative excess|)
  const posSum = excess.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const negSum = excess.filter((r) => r < 0).reduce((s, r) => s + Math.abs(r), 0);
  const omega = negSum > 0 ? posSum / negSum : Infinity;

  return {
    annualReturn: +(annRet * 100).toFixed(2),
    sharpe: +sharpe.toFixed(3),
    sortino: +sortino.toFixed(3),
    calmar: +calmar.toFixed(3),
    omega: +Math.min(omega, 999).toFixed(2),
    dailyMean: +(ss.mean(returns) * 100).toFixed(4),
    dailyStd: +(stdAll * 100).toFixed(4),
    skewness: +ss.sampleSkewness(returns).toFixed(3),
    kurtosis: +ss.sampleKurtosis(returns).toFixed(3),
  };
}

// ── RiskAnalytics 主類 ────────────────────────────────────────────────
export class RiskAnalytics {
  /**
   * @param {object} opts
   * @param {number}  opts.capital       資本
   * @param {number}  opts.confidence    VaR 信心水準（預設 0.95）
   * @param {number}  opts.annualFactor  年化因子（預設 252）
   * @param {number}  opts.riskFreeRate  無風險利率（預設 0.02）
   */
  constructor(opts = {}) {
    this.capital = opts.capital ?? 1_000_000;
    this.confidence = opts.confidence ?? 0.95;
    this.annualFactor = opts.annualFactor ?? 252;
    this.riskFreeRate = opts.riskFreeRate ?? 0.02;
  }

  /**
   * 從回測結果建立完整風險報告
   * @param {object} backtestResult  Backtester.run() 的輸出
   * @returns {object} 完整風險報告
   */
  analyze(backtestResult) {
    const equity = backtestResult.equity ?? [];
    const equityV = equity.map((e) => e.equity);
    const returns = equityV.slice(1).map((e, i) => (e - equityV[i]) / (equityV[i] || 1));

    const hVar = historicalVaR(returns, this.confidence, this.capital);
    const pVar = parametricVaR(returns, this.confidence, this.capital);
    const ddStats = drawdownAnalysis(equityV);
    const ratios = performanceRatios(returns, this.annualFactor, this.riskFreeRate, equityV);

    // 壓力測試：假設以資本為基準的等值部位（用於相對損失估算）
    // 以 1 個單位部位、pointValue = capital 估算整體曝險
    const stressRpt = stressTest({ positions: [], capital: this.capital });

    return {
      period: backtestResult.period,
      capital: backtestResult.capital,
      var: {
        historical: hVar,
        parametric: pVar,
        confidence: this.confidence,
      },
      drawdown: ddStats,
      ratios,
      stress: stressRpt.slice(0, 5), // 前5最壞情境
      trades: backtestResult.trades,
    };
  }

  /**
   * 快速 VaR 摘要（用於 StrategyEngine 定期報告）
   */
  quickVaR(returns) {
    return historicalVaR(returns, this.confidence, this.capital);
  }
}

// ── 報告列印 ──────────────────────────────────────────────────────────
export function printRiskReport(report) {
  const divider = "─".repeat(60);
  console.log(`\n${"═".repeat(60)}`);
  console.log("  📈 風險分析報告");
  if (report.period) {
    console.log(
      `  期間: ${report.period.from?.slice(0, 10)} ~ ${report.period.to?.slice(0, 10)} (${report.period.bars} 根)`,
    );
  }
  console.log(divider);

  // VaR
  const hv = report.var.historical;
  const pv = report.var.parametric;
  console.log(`  VaR (${(report.var.confidence * 100).toFixed(0)}% 信心水準)`);
  console.log(`    歷史模擬: ${(hv.varPct * 100).toFixed(2)}%  (${hv.varAmount.toLocaleString()})`);
  console.log(
    `    CVaR:     ${(hv.cvarPct * 100).toFixed(2)}%  (${hv.cvarAmount.toLocaleString()})`,
  );
  console.log(`    參數化:   ${(pv.varPct * 100).toFixed(2)}%  (${pv.varAmount.toLocaleString()})`);
  console.log(divider);

  // 績效比率
  const r = report.ratios;
  console.log(`  績效比率`);
  console.log(`    年化報酬: ${r.annualReturn}%`);
  console.log(`    Sharpe:   ${r.sharpe}   Sortino: ${r.sortino}   Calmar: ${r.calmar}`);
  console.log(`    Omega:    ${r.omega}    偏度: ${r.skewness}  峰度: ${r.kurtosis}`);
  console.log(divider);

  // 回撤
  const dd = report.drawdown;
  console.log(`  回撤統計`);
  console.log(`    最大回撤: ${dd.maxDrawdown.toLocaleString()} (${dd.maxDrawdownPct}%)`);
  console.log(`    平均回撤: ${dd.avgDrawdown.toLocaleString()} (${dd.avgDrawdownPct}%)`);
  console.log(`    回撤次數: ${dd.drawdownCount}`);
  console.log(divider);

  // 壓力測試
  if (report.stress?.length > 0) {
    console.log("  壓力測試（最惡情境）");
    for (const sc of report.stress) {
      const sev = { 低: "\x1b[32m", 中: "\x1b[33m", 高: "\x1b[31m" }[sc.severity] ?? "";
      const rst = "\x1b[0m";
      console.log(
        `    ${sc.scenario.padEnd(24)} ${sev}${(sc.shockPct + "%").padStart(6)}  損失: ${sc.loss.toLocaleString().padStart(10)}  (${sc.lossCapitalPct}%)${rst}`,
      );
    }
  }

  console.log("═".repeat(60) + "\n");
}
