// Backtester.mjs — 事件驅動回測引擎
// 開源參考：Zipline / Backtrader / QuantConnect LEAN 架構
// 支援：所有繼承 BaseStrategy 的策略、滑點/手續費模型、績效報表
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ss = require("simple-statistics");

// ── 費用模型 ─────────────────────────────────
export class CostModel {
  constructor({ commissionPct = 0.0002, slippageTicks = 1, tickSize = 1 } = {}) {
    this.commissionPct = commissionPct;
    this.slippageTicks = slippageTicks;
    this.tickSize = tickSize;
  }
  fill(direction, price, qty) {
    const slip = this.slippageTicks * this.tickSize * (direction === "buy" ? 1 : -1);
    const fillPrice = price + slip;
    const commission = fillPrice * qty * this.commissionPct;
    return { fillPrice, commission };
  }
}

// ── 回測引擎 ─────────────────────────────────
export class Backtester {
  constructor(config = {}) {
    this.initialCapital = config.initialCapital ?? 1_000_000;
    this.pointValue = config.pointValue ?? 200; // 台指 200/點
    this.cost = new CostModel(config.cost ?? {});

    this._capital = this.initialCapital;
    this._position = 0; // 淨部位
    this._entryPrice = 0;
    this._trades = []; // 每筆交易記錄
    this._equity = []; // 每日資產曲線 { date, equity }
    this._maxEquity = this.initialCapital;
  }

  /** 對一支策略跑完整歷史回測
   * @param {BaseStrategy} strategy  策略實例（已 new 好）
   * @param {Array} bars             OHLCV 陣列 { time, open, high, low, close, volume }
   * @returns {BacktestResult}
   */
  run(strategy, bars) {
    this._reset();
    let prevDate = null;

    for (const bar of bars) {
      strategy.onBar(bar);
      const signals = strategy.popSignals();

      for (const sig of signals) {
        this._execute(sig, bar);
      }

      // 每日標記資產
      const date = bar.time?.slice(0, 10) ?? "";
      if (date !== prevDate) {
        const unrealized =
          this._position !== 0
            ? (bar.close - this._entryPrice) * this._position * this.pointValue
            : 0;
        this._equity.push({ date, equity: this._capital + unrealized });
        prevDate = date;
      }
    }

    // 強制平倉（回測結束）
    if (this._position !== 0) {
      const lastBar = bars[bars.length - 1];
      this._forceClose(lastBar);
    }

    return this._buildResult(strategy.name ?? "Strategy", bars);
  }

  /** 多策略比較回測 */
  runAll(strategies, bars) {
    return strategies.map((strat) => {
      const bt = new Backtester({
        initialCapital: this.initialCapital,
        pointValue: this.pointValue,
        cost: this.cost,
      });
      return bt.run(strat, bars);
    });
  }

  // ── 內部 ─────────────────────────────────────
  _execute(sig, bar) {
    const price = bar.close; // 以收盤價成交（保守模型）
    const { fillPrice, commission } = this.cost.fill(sig.direction, price, sig.qty ?? 1);
    const qty = sig.qty ?? 1;

    if (sig.direction === "buy" && this._position <= 0) {
      if (this._position < 0) {
        this._closeShort(fillPrice, commission, bar.time);
      }
      this._entryPrice = fillPrice;
      this._position = qty;
      this._capital -= commission;
      this._trades.push({
        type: "open",
        direction: "long",
        price: fillPrice,
        qty,
        time: bar.time,
        commission,
      });
    } else if (sig.direction === "sell" && this._position >= 0) {
      if (this._position > 0) {
        this._closeLong(fillPrice, commission, bar.time);
      }
      this._entryPrice = fillPrice;
      this._position = -qty;
      this._capital -= commission;
      this._trades.push({
        type: "open",
        direction: "short",
        price: fillPrice,
        qty,
        time: bar.time,
        commission,
      });
    } else if (sig.direction === "close_long" && this._position > 0) {
      this._closeLong(fillPrice, commission, bar.time);
    } else if (sig.direction === "close_short" && this._position < 0) {
      this._closeShort(fillPrice, commission, bar.time);
    }
  }

  _closeLong(price, commission, time) {
    const pnl =
      (price - this._entryPrice) * Math.abs(this._position) * this.pointValue - commission;
    this._capital += pnl;
    this._maxEquity = Math.max(this._maxEquity, this._capital);
    this._trades.push({ type: "close", direction: "long", price, pnl, time, commission });
    this._position = 0;
    this._entryPrice = 0;
  }

  _closeShort(price, commission, time) {
    const pnl =
      (this._entryPrice - price) * Math.abs(this._position) * this.pointValue - commission;
    this._capital += pnl;
    this._maxEquity = Math.max(this._maxEquity, this._capital);
    this._trades.push({ type: "close", direction: "short", price, pnl, time, commission });
    this._position = 0;
    this._entryPrice = 0;
  }

  _forceClose(bar) {
    const { fillPrice, commission } = this.cost.fill(
      this._position > 0 ? "sell" : "buy",
      bar.close,
      Math.abs(this._position),
    );
    if (this._position > 0) {
      this._closeLong(fillPrice, commission, bar.time);
    } else {
      this._closeShort(fillPrice, commission, bar.time);
    }
  }

  _reset() {
    this._capital = this.initialCapital;
    this._position = 0;
    this._entryPrice = 0;
    this._trades = [];
    this._equity = [];
    this._maxEquity = this.initialCapital;
  }

  // ── 績效計算 ─────────────────────────────────
  _buildResult(name, bars) {
    const closeTrades = this._trades.filter((t) => t.type === "close");
    const pnls = closeTrades.map((t) => t.pnl);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const winRate = pnls.length > 0 ? wins.length / pnls.length : 0;
    const avgWin = wins.length > 0 ? ss.mean(wins) : 0;
    const avgLoss = losses.length > 0 ? ss.mean(losses) : 0;
    const profitFactor =
      losses.length > 0
        ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
        : Infinity;

    // 資產曲線統計
    const equities = this._equity.map((e) => e.equity);
    const finalEquity = equities[equities.length - 1] ?? this.initialCapital;
    const maxDD = this._calcMaxDrawdown(equities);
    const returns = equities.slice(1).map((e, i) => (e - equities[i]) / equities[i]);
    const sharpe =
      returns.length > 1
        ? (ss.mean(returns) / (ss.standardDeviation(returns) || 1)) * Math.sqrt(252)
        : 0;
    const sortino =
      returns.length > 1
        ? (() => {
            const negReturns = returns.filter((r) => r < 0);
            const downDev =
              negReturns.length > 0 ? Math.sqrt(ss.mean(negReturns.map((r) => r * r))) : 1;
            return (ss.mean(returns) / downDev) * Math.sqrt(252);
          })()
        : 0;

    const calmar =
      maxDD < 0
        ? ((totalPnl / this.initialCapital) * 100) / Math.abs((maxDD / this.initialCapital) * 100)
        : 0;

    return {
      strategy: name,
      period: { from: bars[0]?.time, to: bars[bars.length - 1]?.time, bars: bars.length },
      capital: {
        initial: this.initialCapital,
        final: finalEquity,
        totalPnl,
        returnPct: (finalEquity / this.initialCapital - 1) * 100,
      },
      trades: {
        total: closeTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate,
        avgWin,
        avgLoss,
        profitFactor,
      },
      risk: {
        maxDrawdown: maxDD,
        maxDrawdownPct: (maxDD / this.initialCapital) * 100,
        sharpe,
        sortino,
        calmar,
      },
      equity: this._equity,
      tradeLog: this._trades,
    };
  }

  _calcMaxDrawdown(equities) {
    let peak = equities[0] ?? 0,
      maxDD = 0;
    for (const e of equities) {
      if (e > peak) {
        peak = e;
      }
      const dd = e - peak;
      if (dd < maxDD) {
        maxDD = dd;
      }
    }
    return maxDD;
  }
}

// ── 結果報表輸出 ─────────────────────────────
export function printResult(result) {
  const r = result;
  const c = r.capital,
    t = r.trades,
    rk = r.risk;
  console.log(`\n${"═".repeat(55)}`);
  console.log(`📊 回測結果: ${r.strategy}`);
  console.log(
    `   期間: ${r.period.from?.slice(0, 10)} ~ ${r.period.to?.slice(0, 10)} (${r.period.bars} 根K棒)`,
  );
  console.log("─".repeat(55));
  console.log(`💰 損益`);
  console.log(`   初始資金: ${c.initial.toLocaleString()}`);
  console.log(`   最終資金: ${c.final.toLocaleString()}`);
  console.log(
    `   總損益:   ${c.totalPnl.toFixed(0).toLocaleString()} (${c.returnPct.toFixed(2)}%)`,
  );
  console.log("─".repeat(55));
  console.log(`📈 交易統計`);
  console.log(`   總交易: ${t.total}  勝率: ${(t.winRate * 100).toFixed(1)}%`);
  console.log(`   平均獲利: ${t.avgWin.toFixed(0)}  平均虧損: ${t.avgLoss.toFixed(0)}`);
  console.log(`   獲利因子: ${Number.isFinite(t.profitFactor) ? t.profitFactor.toFixed(2) : "∞"}`);
  console.log("─".repeat(55));
  console.log(`⚠️  風險指標`);
  console.log(`   最大回撤: ${rk.maxDrawdown.toFixed(0)} (${rk.maxDrawdownPct.toFixed(2)}%)`);
  console.log(`   夏普比率: ${rk.sharpe.toFixed(2)}`);
  console.log(`   索提諾:   ${rk.sortino.toFixed(2)}`);
  console.log(`   卡瑪比率: ${rk.calmar.toFixed(2)}`);
  console.log(`${"═".repeat(55)}\n`);
}

export function compareResults(results) {
  console.log(`\n${"═".repeat(75)}`);
  console.log(`📊 策略比較`);
  console.log("─".repeat(75));
  console.log(
    `${"策略".padEnd(28)} ${"報酬%".padStart(8)} ${"勝率%".padStart(7)} ${"獲利因子".padStart(8)} ${"夏普".padStart(7)} ${"最大回撤%".padStart(9)}`,
  );
  console.log("─".repeat(75));
  for (const r of results.toSorted((a, b) => b.risk.sharpe - a.risk.sharpe)) {
    console.log(
      `${r.strategy.padEnd(28)} ` +
        `${r.capital.returnPct.toFixed(2).padStart(8)} ` +
        `${(r.trades.winRate * 100).toFixed(1).padStart(7)} ` +
        `${(Number.isFinite(r.trades.profitFactor) ? r.trades.profitFactor.toFixed(2) : "∞").padStart(8)} ` +
        `${r.risk.sharpe.toFixed(2).padStart(7)} ` +
        `${r.risk.maxDrawdownPct.toFixed(2).padStart(9)}`,
    );
  }
  console.log(`${"═".repeat(75)}\n`);
}
