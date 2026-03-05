import { describe, expect, it } from "vitest";
import { toBacktestResult } from "./result-mapper.js";
import type { RemoteReport } from "./types.js";

// Mock report matching real API v1.1 format:
// - performance uses short names (sharpe, not sharpeRatio)
// - values are percentage (15.0 = 15%), not decimal (0.15)
// - equity_curve/trade_journal may be null
const MOCK_REPORT: RemoteReport = {
  task_id: "t-42",
  performance: {
    totalReturn: 15.0, // 15%
    sharpe: 1.23,
    sortino: 1.56,
    maxDrawdown: 8.2, // 8.2%
    calmar: 1.83,
    winRate: 55.0, // 55%
    profitFactor: 1.78,
    totalTrades: 24,
    finalEquity: 115000,
    annualizedReturn: 14.5,
    maxDrawdownStart: "2024-03-01",
    maxDrawdownEnd: "2024-04-15",
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

  it("maps performance fields and converts percentages to decimals", () => {
    expect(result.strategyId).toBe("momentum_v1");
    expect(result.initialCapital).toBe(100000);
    expect(result.finalEquity).toBe(115000);
    // totalReturn: 15.0% → 0.15
    expect(result.totalReturn).toBeCloseTo(0.15, 6);
    expect(result.sharpe).toBe(1.23);
    expect(result.sortino).toBe(1.56);
    // maxDrawdown: 8.2% → 0.082
    expect(result.maxDrawdown).toBeCloseTo(0.082, 6);
    expect(result.calmar).toBe(1.83);
    // winRate: 55.0% → 0.55
    expect(result.winRate).toBeCloseTo(0.55, 6);
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

  it("handles null trade_journal and equity_curve", () => {
    const nullReport: RemoteReport = {
      task_id: "t-null",
      performance: {
        totalReturn: -23.91,
        sharpe: -1.63,
        sortino: -2.26,
        maxDrawdown: 25.21,
        calmar: -0.95,
        winRate: 51.06,
        profitFactor: 0.74,
        totalTrades: 47,
        finalEquity: 7608.55,
      },
      alpha: null,
      trade_journal: null,
      equity_curve: null,
    };

    const r = toBacktestResult(nullReport, {
      strategyId: "real-api",
      initialCapital: 10000,
    });

    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
    expect(r.dailyReturns).toEqual([]);
    expect(r.totalReturn).toBeCloseTo(-0.2391, 4);
    expect(r.maxDrawdown).toBeCloseTo(0.2521, 4);
    expect(r.winRate).toBeCloseTo(0.5106, 4);
    expect(r.finalEquity).toBe(7608.55);
  });

  it("computes finalEquity from totalReturn when not in performance", () => {
    const minimalReport: RemoteReport = {
      task_id: "t-min",
      performance: {
        totalReturn: 25.0, // 25%
        maxDrawdown: 5.0,
        totalTrades: 10,
      },
      alpha: null,
      trade_journal: null,
      equity_curve: null,
    };

    const r = toBacktestResult(minimalReport, {
      strategyId: "minimal",
      initialCapital: 50000,
    });

    // finalEquity = 50000 * (1 + 25/100) = 62500
    expect(r.finalEquity).toBe(62500);
  });
});
