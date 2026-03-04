import { describe, it, expect } from "vitest";
import type { StrategyDefinition, BacktestConfig, OHLCV } from "../../src/shared/types.js";
import { BacktestEngine, type BacktestProgress } from "../../src/strategy/backtest-engine.js";
import { BacktestProgressStore } from "../../src/strategy/backtest-progress-store.js";

// Helper to create OHLCV data
function makeOhlcv(count: number): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1700000000000 + i * 86400000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000,
  }));
}

// Simple strategy that always holds
function makeStrategy(id = "test-strategy"): StrategyDefinition {
  return {
    id,
    name: "Test Strategy",
    version: "1.0",
    markets: ["crypto"],
    symbols: ["BTC/USDT"],
    timeframes: ["1d"],
    parameters: {},
    async onBar() {
      return null;
    },
  };
}

describe("BacktestEngine onProgress", () => {
  it("should call onProgress during execution", async () => {
    const engine = new BacktestEngine();
    const progressUpdates: BacktestProgress[] = [];
    const data = makeOhlcv(100);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    await engine.run(makeStrategy(), data, config, (p) => progressUpdates.push(p));

    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates.some((p) => p.status === "running")).toBe(true);
  });

  it("should report 100% when completed", async () => {
    const engine = new BacktestEngine();
    const progressUpdates: BacktestProgress[] = [];
    const data = makeOhlcv(50);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    await engine.run(makeStrategy(), data, config, (p) => progressUpdates.push(p));

    const last = progressUpdates[progressUpdates.length - 1]!;
    expect(last.percentComplete).toBe(100);
    expect(last.status).toBe("completed");
  });

  it("should work without onProgress (backward compatible)", async () => {
    const engine = new BacktestEngine();
    const data = makeOhlcv(20);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    const result = await engine.run(makeStrategy(), data, config);
    expect(result.totalTrades).toBeDefined();
    expect(result.equityCurve.length).toBe(20);
  });
});

describe("BacktestProgressStore", () => {
  it("report() should notify subscribers", () => {
    const store = new BacktestProgressStore();
    const received: BacktestProgress[] = [];
    store.subscribe("test-strat", (p) => received.push(p));

    store.report({
      strategyId: "test-strat",
      currentBar: 50,
      totalBars: 100,
      percentComplete: 50,
      currentEquity: 10500,
      status: "running",
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.percentComplete).toBe(50);
  });

  it("subscribe() returns unsubscribe function", () => {
    const store = new BacktestProgressStore();
    const received: BacktestProgress[] = [];
    const unsub = store.subscribe("test-strat", (p) => received.push(p));

    store.report({
      strategyId: "test-strat",
      currentBar: 1,
      totalBars: 10,
      percentComplete: 10,
      currentEquity: 10000,
      status: "running",
    });
    unsub();
    store.report({
      strategyId: "test-strat",
      currentBar: 5,
      totalBars: 10,
      percentComplete: 50,
      currentEquity: 10000,
      status: "running",
    });

    expect(received).toHaveLength(1);
  });

  it("getActive() returns only in-progress backtests", () => {
    const store = new BacktestProgressStore();

    store.report({
      strategyId: "s1",
      currentBar: 5,
      totalBars: 10,
      percentComplete: 50,
      currentEquity: 10000,
      status: "running",
    });
    store.report({
      strategyId: "s2",
      currentBar: 10,
      totalBars: 10,
      percentComplete: 100,
      currentEquity: 11000,
      status: "completed",
    });

    const active = store.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.strategyId).toBe("s1");
  });
});
