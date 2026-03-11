import { describe, it, expect, vi } from "vitest";
import type { BacktestResult } from "../shared/types.js";
import { ScreeningPipeline } from "./screening-pipeline.js";

function makeBt(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    strategyId: "test",
    startDate: 0,
    endDate: 1,
    initialCapital: 10000,
    finalEquity: 12000,
    totalReturn: 20,
    sharpe: 1.2,
    sortino: 1.5,
    maxDrawdown: -15,
    calmar: 1.0,
    winRate: 0.55,
    profitFactor: 1.8,
    totalTrades: 100,
    trades: [],
    equityCurve: [],
    dailyReturns: [],
    ...overrides,
  };
}

describe("ScreeningPipeline", () => {
  it("passes strategy meeting all thresholds", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi
          .fn()
          .mockResolvedValue(makeBt({ sharpe: 1.2, maxDrawdown: -15, totalTrades: 100 })),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].failReason).toBeUndefined();
    expect(results[0].quickBacktest.sharpe).toBe(1.2);
  });

  it("fails strategy with low Sharpe", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi.fn().mockResolvedValue(makeBt({ sharpe: 0.3, totalTrades: 100 })),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results[0].passed).toBe(false);
    expect(results[0].failReason).toContain("Sharpe");
  });

  it("fails strategy with excessive drawdown", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi.fn().mockResolvedValue(makeBt({ maxDrawdown: -45 })),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results[0].passed).toBe(false);
    expect(results[0].failReason).toContain("MaxDD");
  });

  it("fails strategy with too few trades", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi.fn().mockResolvedValue(makeBt({ totalTrades: 10 })),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results[0].passed).toBe(false);
    expect(results[0].failReason).toContain("Trades");
  });

  it("handles null backtest result", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi.fn().mockResolvedValue(null),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results[0].passed).toBe(false);
    expect(results[0].failReason).toContain("no result");
  });

  it("handles backtest error", async () => {
    const pipeline = new ScreeningPipeline({
      backtestService: {
        runBacktest: vi.fn().mockRejectedValue(new Error("timeout")),
      },
    });

    const results = await pipeline.screen(["strat-1"]);
    expect(results[0].passed).toBe(false);
    expect(results[0].failReason).toContain("timeout");
  });

  it("screens multiple strategies", async () => {
    const runBacktest = vi
      .fn()
      .mockResolvedValueOnce(makeBt({ sharpe: 1.5, totalTrades: 200 }))
      .mockResolvedValueOnce(makeBt({ sharpe: 0.1, totalTrades: 5 }));

    const pipeline = new ScreeningPipeline({ backtestService: { runBacktest } });

    const results = await pipeline.screen(["good", "bad"]);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});
