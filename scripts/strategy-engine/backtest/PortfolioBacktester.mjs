// PortfolioBacktester.mjs — 多策略組合回測
// 解決問題：原 Backtester 一次只跑一個策略，無法評估整體組合績效
//
// 功能：
//   同時跑多個策略，共享帳戶資金
//   統一部位管理（同商品多策略相加）
//   組合層級統計（Sharpe、回撤、相關性）
//   策略貢獻度分析（Attribution）

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ss = require("simple-statistics");

export class PortfolioBacktester {
  /**
   * @param {object} opts
   * @param {number}  opts.initialCapital
   * @param {number}  opts.pointValue      每點價值（台指 200）
   * @param {object}  opts.cost            { commissionPct, slippageTicks, tickSize }
   * @param {number}  opts.annualFactor    年化因子（252 for daily）
   */
  constructor(opts = {}) {
    this.initialCapital = opts.initialCapital ?? 1_000_000;
    this.pointValue = opts.pointValue ?? 200;
    this.annualFactor = opts.annualFactor ?? 252;
    this.cost = {
      commissionPct: opts.cost?.commissionPct ?? 0.0002,
      slippageTicks: opts.cost?.slippageTicks ?? 1,
      tickSize: opts.cost?.tickSize ?? 1,
    };
  }

  /**
   * 同時回測多個策略（共享帳戶）
   * @param {BaseStrategy[]} strategies   策略陣列（已 new 好）
   * @param {object[][]}     barsByStrat  每個策略對應的 OHLCV 陣列
   *                                     若長度=1，所有策略用同一份
   * @returns {PortfolioResult}
   */
  run(strategies, barsByStrat) {
    // 若只提供一份 bars，所有策略共用
    const allBars = barsByStrat.length === 1 ? strategies.map(() => barsByStrat[0]) : barsByStrat;

    // 確認 bars 長度一致（以最短為準）
    const T = Math.min(...allBars.map((b) => b.length));

    let capital = this.initialCapital;
    let peakCapital = this.initialCapital;
    const equity = []; // 每日組合淨值
    const positions = {}; // instrument → { qty, avgPrice }
    const stratStats = strategies.map((s) => ({
      name: s.name,
      pnl: 0,
      trades: 0,
      wins: 0,
      pnls: [],
    }));

    // 每日循環
    for (let t = 0; t < T; t++) {
      // 每個策略接收 bar
      for (let i = 0; i < strategies.length; i++) {
        strategies[i].onBar(allBars[i][t]);
      }

      // 收集並執行訊號
      for (let i = 0; i < strategies.length; i++) {
        const strat = strategies[i];
        const bar = allBars[i][t];
        const signals = strat.popSignals();

        for (const sig of signals) {
          const inst = sig.instrument ?? "UNKNOWN";
          const qty = sig.qty ?? 1;
          const slip = this.cost.slippageTicks * this.cost.tickSize;
          const price = sig.direction === "buy" ? bar.close + slip : bar.close - slip;
          const comm = price * qty * this.cost.commissionPct;

          if (!positions[inst]) {
            positions[inst] = { qty: 0, avgPrice: 0 };
          }
          const pos = positions[inst];

          let pnl = 0;
          if (sig.direction === "buy") {
            if (pos.qty < 0) {
              // 平空
              const closeQty = Math.min(qty, Math.abs(pos.qty));
              pnl = (pos.avgPrice - price) * closeQty * this.pointValue - comm;
              pos.qty += closeQty;
              if (pos.qty === 0) {
                pos.avgPrice = 0;
              }
            }
            if (pos.qty >= 0) {
              // 開多/加多
              const newQty = pos.qty + qty;
              pos.avgPrice = newQty > 0 ? (pos.avgPrice * pos.qty + price * qty) / newQty : price;
              pos.qty = newQty;
            }
          } else if (sig.direction === "sell") {
            if (pos.qty > 0) {
              const closeQty = Math.min(qty, pos.qty);
              pnl = (price - pos.avgPrice) * closeQty * this.pointValue - comm;
              pos.qty -= closeQty;
              if (pos.qty === 0) {
                pos.avgPrice = 0;
              }
            }
            if (pos.qty <= 0) {
              const newQty = pos.qty - qty;
              pos.avgPrice =
                newQty < 0
                  ? (pos.avgPrice * Math.abs(pos.qty) + price * qty) / Math.abs(newQty)
                  : price;
              pos.qty = newQty;
            }
          } else if (sig.direction === "close_long" && pos.qty > 0) {
            const closeQty = Math.min(qty, pos.qty);
            pnl = (price - pos.avgPrice) * closeQty * this.pointValue - comm;
            pos.qty -= closeQty;
            if (pos.qty === 0) {
              pos.avgPrice = 0;
            }
          } else if (sig.direction === "close_short" && pos.qty < 0) {
            const closeQty = Math.min(qty, Math.abs(pos.qty));
            pnl = (pos.avgPrice - price) * closeQty * this.pointValue - comm;
            pos.qty += closeQty;
            if (pos.qty === 0) {
              pos.avgPrice = 0;
            }
          }

          // 更新資金與策略統計
          if (pnl !== 0) {
            capital += pnl;
            stratStats[i].pnl += pnl;
            stratStats[i].trades += 1;
            if (pnl > 0) {
              stratStats[i].wins++;
            }
            stratStats[i].pnls.push(pnl);
          }
        }
      }

      // 計算未實現損益
      const unrealized = Object.values(positions).reduce((s, pos) => {
        if (pos.qty === 0) {
          return s;
        }
        // 用最後一個策略的 bar 作為市價（近似）
        const lastBar = allBars[0][t];
        return s + (lastBar.close - pos.avgPrice) * pos.qty * this.pointValue;
      }, 0);

      peakCapital = Math.max(peakCapital, capital + unrealized);
      equity.push({
        date: allBars[0][t].time?.slice(0, 10) ?? String(t),
        equity: capital + unrealized,
        realized: capital,
      });
    }

    // 強制平倉（組合結束）
    const lastBar = allBars[0][T - 1];
    for (const pos of Object.values(positions)) {
      if (pos.qty === 0) {
        continue;
      }
      const slip = this.cost.slippageTicks * this.cost.tickSize;
      const price = pos.qty > 0 ? lastBar.close - slip : lastBar.close + slip;
      const pnl =
        (pos.qty > 0
          ? (price - pos.avgPrice) * pos.qty
          : (pos.avgPrice - price) * Math.abs(pos.qty)) * this.pointValue;
      capital += pnl;
    }

    return this._buildResult(capital, equity, peakCapital, stratStats, allBars[0]);
  }

  _buildResult(finalCapital, equity, peakCapital, stratStats, bars) {
    const equities = equity.map((e) => e.equity);
    const returns = equities.slice(1).map((e, i) => (e - equities[i]) / equities[i]);
    const totalPnl = finalCapital - this.initialCapital;

    const maxDD = equities.reduce(
      (state, e) => {
        state.peak = Math.max(state.peak, e);
        state.dd = Math.min(state.dd, e - state.peak);
        return state;
      },
      { peak: equities[0], dd: 0 },
    ).dd;

    const sharpe =
      returns.length > 1
        ? (ss.mean(returns) / (ss.standardDeviation(returns) || 1)) * Math.sqrt(this.annualFactor)
        : 0;
    const negRets = returns.filter((r) => r < 0);
    const sortino =
      returns.length > 1 && negRets.length > 0
        ? (ss.mean(returns) / Math.sqrt(ss.mean(negRets.map((r) => r * r)))) *
          Math.sqrt(this.annualFactor)
        : 0;

    return {
      type: "portfolio",
      period: { from: bars[0]?.time, to: bars[bars.length - 1]?.time, bars: bars.length },
      capital: {
        initial: this.initialCapital,
        final: finalCapital,
        totalPnl,
        returnPct: +((finalCapital / this.initialCapital - 1) * 100).toFixed(2),
      },
      risk: {
        maxDrawdown: maxDD,
        maxDrawdownPct: +((maxDD / this.initialCapital) * 100).toFixed(2),
        sharpe: +sharpe.toFixed(3),
        sortino: +sortino.toFixed(3),
      },
      equity,
      strategyAttribution: stratStats.map((s) => ({
        name: s.name,
        pnl: +s.pnl.toFixed(0),
        trades: s.trades,
        winRate: s.trades > 0 ? +((s.wins / s.trades) * 100).toFixed(1) : 0,
        pct: totalPnl !== 0 ? +((s.pnl / Math.abs(totalPnl)) * 100).toFixed(1) : 0,
      })),
    };
  }
}

export function printPortfolioResult(r) {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  📊 組合回測結果");
  console.log(
    `  期間: ${r.period.from?.slice(0, 10)} ~ ${r.period.to?.slice(0, 10)} (${r.period.bars} 根)`,
  );
  console.log("─".repeat(60));
  console.log(
    `  總損益:   ${r.capital.totalPnl >= 0 ? "+" : ""}${r.capital.totalPnl.toFixed(0)}  (${r.capital.returnPct}%)`,
  );
  console.log(`  最大回撤: ${r.risk.maxDrawdown.toFixed(0)} (${r.risk.maxDrawdownPct}%)`);
  console.log(`  夏普比率: ${r.risk.sharpe}  索提諾: ${r.risk.sortino}`);
  console.log("─".repeat(60));
  console.log("  策略貢獻度:");
  for (const s of r.strategyAttribution.toSorted((a, b) => b.pnl - a.pnl)) {
    const bar = "█".repeat(Math.max(0, Math.round(Math.abs(s.pct) / 5)));
    const sign = s.pnl >= 0 ? "+" : "";
    console.log(
      `    ${s.name.padEnd(22)} ${(sign + s.pnl).padStart(8)}  ${(s.winRate + "%").padStart(6)}  ${bar} ${s.pct}%`,
    );
  }
  console.log("═".repeat(60) + "\n");
}
