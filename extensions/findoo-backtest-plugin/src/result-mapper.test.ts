import { describe, expect, it } from "vitest";
import { toBacktestResult } from "./result-mapper.js";
import type { RemoteReport } from "./types.js";

const MOCK_REPORT: RemoteReport = {
  task_id: "t-42",
  result_summary: {
    total_return: 0.15,
    sharpe_ratio: 1.23,
    sortino_ratio: 1.56,
    max_drawdown: -0.082,
    calmar_ratio: 1.83,
    win_rate: 0.55,
    profit_factor: 1.78,
    total_trades: 24,
    final_equity: 115000,
    alpha: 0.03,
  },
  trades: [
    {
      entry_time: "2024-02-15T10:00:00Z",
      exit_time: "2024-02-20T14:00:00Z",
      symbol: "BTC-USD",
      side: "long",
      entry_price: 42000,
      exit_price: 45000,
      quantity: 1.5,
      commission: 12.5,
      slippage: 5.0,
      pnl: 4482.5,
      pnl_pct: 0.0714,
      reason: "momentum_signal",
      exit_reason: "take_profit",
    },
  ],
  equity_curve: [
    { date: "2024-01-01", equity: 100000 },
    { date: "2024-01-02", equity: 101500 },
    { date: "2024-01-03", equity: 103200 },
    { date: "2024-01-04", equity: 102800 },
    { date: "2024-01-05", equity: 105000 },
  ],
};

describe("toBacktestResult", () => {
  const result = toBacktestResult(MOCK_REPORT, {
    strategyId: "momentum_v1",
    initialCapital: 100000,
  });

  it("maps summary fields correctly", () => {
    expect(result.strategyId).toBe("momentum_v1");
    expect(result.initialCapital).toBe(100000);
    expect(result.finalEquity).toBe(115000);
    expect(result.totalReturn).toBe(0.15);
    expect(result.sharpe).toBe(1.23);
    expect(result.sortino).toBe(1.56);
    expect(result.maxDrawdown).toBe(-0.082);
    expect(result.calmar).toBe(1.83);
    expect(result.winRate).toBe(0.55);
    expect(result.profitFactor).toBe(1.78);
    expect(result.totalTrades).toBe(24);
  });

  it("maps trades from snake_case to camelCase", () => {
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0];
    expect(t.entryPrice).toBe(42000);
    expect(t.exitPrice).toBe(45000);
    expect(t.quantity).toBe(1.5);
    expect(t.pnl).toBe(4482.5);
    expect(t.pnlPct).toBe(0.0714);
    expect(t.side).toBe("long");
    expect(t.reason).toBe("momentum_signal");
    expect(t.exitReason).toBe("take_profit");
    // Timestamps are Unix ms
    expect(t.entryTime).toBe(new Date("2024-02-15T10:00:00Z").getTime());
    expect(t.exitTime).toBe(new Date("2024-02-20T14:00:00Z").getTime());
  });

  it("extracts equity curve as number array", () => {
    expect(result.equityCurve).toEqual([100000, 101500, 103200, 102800, 105000]);
  });

  it("computes daily returns from equity curve", () => {
    expect(result.dailyReturns).toHaveLength(4);
    // Day 1 return: (101500 - 100000) / 100000 = 0.015
    expect(result.dailyReturns[0]).toBeCloseTo(0.015, 6);
    // Day 3 return: (102800 - 103200) / 103200 ≈ -0.003876
    expect(result.dailyReturns[2]).toBeCloseTo(-0.003876, 4);
  });

  it("derives dates from equity curve", () => {
    expect(result.startDate).toBe(new Date("2024-01-01").getTime());
    expect(result.endDate).toBe(new Date("2024-01-05").getTime());
  });

  it("handles empty trades and equity curve", () => {
    const emptyReport: RemoteReport = {
      task_id: "t-empty",
      result_summary: {
        total_return: 0,
        sharpe_ratio: 0,
        sortino_ratio: 0,
        max_drawdown: 0,
        calmar_ratio: 0,
        win_rate: 0,
        profit_factor: 0,
        total_trades: 0,
        final_equity: 100000,
      },
      trades: [],
      equity_curve: [],
    };

    const r = toBacktestResult(emptyReport, {
      strategyId: "empty",
      initialCapital: 100000,
    });

    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
    expect(r.dailyReturns).toEqual([]);
    expect(r.startDate).toBe(0);
    expect(r.endDate).toBe(0);
  });
});
