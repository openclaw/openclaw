import { describe, expect, it } from "vitest";
import { toBacktestResult } from "./result-mapper.js";
import type { RemoteReport } from "./types.js";

const MOCK_REPORT: RemoteReport = {
  task_id: "t-42",
  metadata: { strategy_name: "momentum_v1" },
  performance: {
    totalReturn: 0.15,
    sharpeRatio: 1.23,
    sortinoRatio: 1.56,
    maxDrawdown: -0.082,
    calmarRatio: 1.83,
    winRate: 0.55,
    profitFactor: 1.78,
    totalTrades: 24,
    finalEquity: 115000,
  },
  alpha: null,
  trade_journal: [
    {
      date: "2024-02-15T10:00:00Z",
      action: "buy",
      amount: 1.5,
      price: 42000,
      reason: "momentum_signal",
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

  it("maps performance fields correctly (camelCase)", () => {
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

  it("maps trade_journal entries to TradeRecord", () => {
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0];
    expect(t.entryPrice).toBe(42000);
    expect(t.exitPrice).toBe(42000); // v1.1: single date/price per entry
    expect(t.quantity).toBe(1.5);
    expect(t.side).toBe("long"); // action=buy → long
    expect(t.reason).toBe("momentum_signal");
    expect(t.entryTime).toBe(new Date("2024-02-15T10:00:00Z").getTime());
  });

  it("extracts equity curve as number array", () => {
    expect(result.equityCurve).toEqual([100000, 101500, 103200, 102800, 105000]);
  });

  it("computes daily returns from equity curve", () => {
    expect(result.dailyReturns).toHaveLength(4);
    expect(result.dailyReturns[0]).toBeCloseTo(0.015, 6);
    expect(result.dailyReturns[2]).toBeCloseTo(-0.003876, 4);
  });

  it("derives dates from equity curve", () => {
    expect(result.startDate).toBe(new Date("2024-01-01").getTime());
    expect(result.endDate).toBe(new Date("2024-01-05").getTime());
  });

  it("handles empty trade_journal and equity_curve", () => {
    const emptyReport: RemoteReport = {
      task_id: "t-empty",
      metadata: null,
      performance: {
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        totalTrades: 0,
      },
      alpha: null,
      trade_journal: [],
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

  it("computes finalEquity from totalReturn when not in performance", () => {
    const minimalReport: RemoteReport = {
      task_id: "t-min",
      metadata: null,
      performance: {
        totalReturn: 0.25,
        sharpeRatio: 1.0,
        maxDrawdown: -0.05,
        totalTrades: 10,
      },
      alpha: null,
      trade_journal: [],
      equity_curve: [],
    };

    const r = toBacktestResult(minimalReport, {
      strategyId: "minimal",
      initialCapital: 50000,
    });

    // finalEquity = 50000 * (1 + 0.25) = 62500
    expect(r.finalEquity).toBe(62500);
  });
});
