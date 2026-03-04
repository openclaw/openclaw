import { describe, expect, it, vi } from "vitest";
import { FundRiskManager } from "../../src/fund/fund-risk-manager.js";
import type { Allocation, FundConfig } from "../../src/fund/types.js";

vi.mock("ccxt", () => ({}));

const config: FundConfig = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly",
};

function makeAllocations(total: number): Allocation[] {
  return [{ strategyId: "s1", capitalUsd: total, weightPct: total / 1000, reason: "test" }];
}

describe("FundRiskManager", () => {
  it("reports normal risk when no drawdown", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const status = rm.evaluate(100000, makeAllocations(50000));

    expect(status.riskLevel).toBe("normal");
    expect(status.todayPnl).toBe(0);
    expect(status.dailyDrawdown).toBe(0);
    expect(status.totalEquity).toBe(100000);
  });

  it("reports caution on >3% daily drawdown", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const status = rm.evaluate(96000, makeAllocations(50000));

    expect(status.riskLevel).toBe("caution");
    expect(status.todayPnlPct).toBeCloseTo(-4, 0);
    expect(status.dailyDrawdown).toBeCloseTo(4, 0);
  });

  it("reports warning on >5% daily drawdown", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const status = rm.evaluate(93000, makeAllocations(50000));

    expect(status.riskLevel).toBe("warning");
    expect(status.dailyDrawdown).toBeCloseTo(7, 0);
  });

  it("reports critical on >10% daily drawdown", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const status = rm.evaluate(88000, makeAllocations(50000));

    expect(status.riskLevel).toBe("critical");
    expect(status.dailyDrawdown).toBeCloseTo(12, 0);
  });

  it("computes exposure and cash reserve percentages", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const alloc = makeAllocations(60000);
    const status = rm.evaluate(100000, alloc);

    expect(status.exposurePct).toBeCloseTo(60, 0);
    expect(status.cashReservePct).toBeCloseTo(40, 0);
    expect(status.activeStrategies).toBe(1);
  });

  it("reports positive PnL correctly", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(100000);
    const status = rm.evaluate(105000, makeAllocations(50000));

    expect(status.riskLevel).toBe("normal");
    expect(status.todayPnl).toBe(5000);
    expect(status.todayPnlPct).toBeCloseTo(5, 0);
    expect(status.dailyDrawdown).toBe(0);
  });

  describe("getScaleFactor", () => {
    const rm = new FundRiskManager(config);

    it("returns 1.0 for normal", () => {
      expect(rm.getScaleFactor("normal")).toBe(1.0);
    });

    it("returns 0.8 for caution", () => {
      expect(rm.getScaleFactor("caution")).toBe(0.8);
    });

    it("returns 0.5 for warning", () => {
      expect(rm.getScaleFactor("warning")).toBe(0.5);
    });

    it("returns 0 for critical", () => {
      expect(rm.getScaleFactor("critical")).toBe(0);
    });
  });

  it("handles zero starting equity gracefully", () => {
    const rm = new FundRiskManager(config);
    rm.markDayStart(0);
    const status = rm.evaluate(0, []);

    expect(status.riskLevel).toBe("normal");
    expect(status.todayPnlPct).toBe(0);
    expect(status.cashReservePct).toBe(100);
  });
});
