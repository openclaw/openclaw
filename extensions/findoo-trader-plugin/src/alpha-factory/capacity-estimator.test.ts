import { describe, it, expect, vi } from "vitest";
import type { TradeRecord } from "../shared/types.js";
import { CapacityEstimator } from "./capacity-estimator.js";

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    entryTime: 1000000,
    exitTime: 1086400000,
    symbol: "BTC/USDT",
    side: "long",
    entryPrice: 50000,
    exitPrice: 51000,
    quantity: 0.1,
    commission: 5,
    slippage: 2,
    pnl: 100,
    pnlPct: 2,
    reason: "signal",
    exitReason: "tp",
    ...overrides,
  };
}

describe("CapacityEstimator", () => {
  it("returns zeros for empty trades", async () => {
    const estimator = new CapacityEstimator();
    const result = await estimator.estimate([], "BTC/USDT");
    expect(result.maxCapitalUsd).toBe(0);
    expect(result.avgDailyVolume).toBe(0);
  });

  it("estimates from trades when no data provider", async () => {
    const trades = [
      makeTrade({ entryTime: 0, exitTime: 86_400_000, quantity: 1, entryPrice: 50000 }),
      makeTrade({ entryTime: 86_400_000, exitTime: 172_800_000, quantity: 0.5, entryPrice: 50000 }),
    ];

    const estimator = new CapacityEstimator();
    const result = await estimator.estimate(trades, "BTC/USDT");

    expect(result.avgDailyVolume).toBeGreaterThan(0);
    expect(result.maxCapitalUsd).toBeGreaterThan(0);
    expect(result.participationRate).toBe(0.01);
    expect(result.impactCostBps).toBe(1); // 0.01 * 100
  });

  it("uses data provider volume when available", async () => {
    const dataProvider = {
      getVolume: vi.fn().mockResolvedValue(1_000_000),
    };

    const estimator = new CapacityEstimator({ dataProvider });
    const result = await estimator.estimate([makeTrade()], "BTC/USDT", "crypto");

    expect(dataProvider.getVolume).toHaveBeenCalledWith("BTC/USDT", "crypto");
    expect(result.avgDailyVolume).toBe(1_000_000);
    expect(result.maxCapitalUsd).toBe(10_000); // 1M * 0.01
  });

  it("falls back to trade estimation when provider returns null", async () => {
    const dataProvider = {
      getVolume: vi.fn().mockResolvedValue(null),
    };

    const estimator = new CapacityEstimator({ dataProvider });
    const result = await estimator.estimate([makeTrade()], "BTC/USDT");

    expect(result.avgDailyVolume).toBeGreaterThan(0);
  });

  it("defaults market to crypto", async () => {
    const dataProvider = {
      getVolume: vi.fn().mockResolvedValue(500_000),
    };

    const estimator = new CapacityEstimator({ dataProvider });
    await estimator.estimate([makeTrade()], "ETH/USDT");

    expect(dataProvider.getVolume).toHaveBeenCalledWith("ETH/USDT", "crypto");
  });
});
