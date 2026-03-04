import { describe, expect, it, vi } from "vitest";
import { CapitalAllocator } from "../../src/fund/capital-allocator.js";
import type { FundConfig, StrategyProfile } from "../../src/fund/types.js";

vi.mock("ccxt", () => ({}));

const defaultConfig: FundConfig = {
  totalCapital: 100000,
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly",
};

function makeProfile(overrides: Partial<StrategyProfile> & { id: string }): StrategyProfile {
  return {
    name: overrides.id,
    level: "L3_LIVE",
    fitness: 1.0,
    paperDaysActive: 60,
    ...overrides,
  };
}

describe("CapitalAllocator", () => {
  const allocator = new CapitalAllocator();

  it("returns empty allocations for no strategies", () => {
    const result = allocator.allocate([], 100000, defaultConfig);
    expect(result).toEqual([]);
  });

  it("returns empty allocations for zero capital", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 1.5 })];
    const result = allocator.allocate(strategies, 0, defaultConfig);
    expect(result).toEqual([]);
  });

  it("allocates to a single L3 strategy", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 2.0 })];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0]!.strategyId).toBe("s1");
    expect(result[0]!.capitalUsd).toBeGreaterThan(0);
    expect(result[0]!.capitalUsd).toBeLessThanOrEqual(30000);
  });

  it("skips strategies with negative fitness", () => {
    const strategies = [
      makeProfile({ id: "good", fitness: 1.5 }),
      makeProfile({ id: "bad", fitness: -0.5 }),
    ];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0]!.strategyId).toBe("good");
  });

  it("skips L0 and L1 strategies", () => {
    const strategies = [
      makeProfile({ id: "incubate", fitness: 2.0, level: "L0_INCUBATE" }),
      makeProfile({ id: "backtest", fitness: 1.8, level: "L1_BACKTEST" }),
      makeProfile({ id: "paper", fitness: 1.5, level: "L2_PAPER" }),
    ];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result).toHaveLength(1);
    expect(result[0]!.strategyId).toBe("paper");
  });

  it("allocates proportionally to fitness", () => {
    const strategies = [
      makeProfile({ id: "high", fitness: 3.0 }),
      makeProfile({ id: "low", fitness: 1.0 }),
    ];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result).toHaveLength(2);
    const highAlloc = result.find((r) => r.strategyId === "high")!;
    const lowAlloc = result.find((r) => r.strategyId === "low")!;
    expect(highAlloc.capitalUsd).toBeGreaterThan(lowAlloc.capitalUsd);
  });

  it("total allocation does not exceed maxTotalExposurePct", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 3.0 }),
      makeProfile({ id: "s2", fitness: 2.5 }),
      makeProfile({ id: "s3", fitness: 2.0 }),
      makeProfile({ id: "s4", fitness: 1.5 }),
    ];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    const totalAllocated = result.reduce((sum, a) => sum + a.capitalUsd, 0);
    expect(totalAllocated).toBeLessThanOrEqual(70000 + 1);
  });

  it("caps single strategy at maxSingleStrategyPct", () => {
    const strategies = [makeProfile({ id: "dominant", fitness: 10.0 })];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result[0]!.capitalUsd).toBeLessThanOrEqual(30000);
  });

  it("caps new L3 strategies at 10%", () => {
    const strategies = [
      makeProfile({ id: "newbie", fitness: 5.0, level: "L3_LIVE", paperDaysActive: 10 }),
    ];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result[0]!.weightPct).toBeLessThanOrEqual(10);
  });

  it("caps L2 paper strategies at 15%", () => {
    const strategies = [makeProfile({ id: "paper-s", fitness: 5.0, level: "L2_PAPER" })];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result[0]!.weightPct).toBeLessThanOrEqual(15);
  });

  it("applies correlation constraints", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 2.0 }),
      makeProfile({ id: "s2", fitness: 2.0 }),
      makeProfile({ id: "s3", fitness: 2.0 }),
    ];

    const correlations = new Map<string, Map<string, number>>();
    correlations.set(
      "s1",
      new Map([
        ["s1", 1],
        ["s2", 0.9],
        ["s3", 0.1],
      ]),
    );
    correlations.set(
      "s2",
      new Map([
        ["s1", 0.9],
        ["s2", 1],
        ["s3", 0.2],
      ]),
    );
    correlations.set(
      "s3",
      new Map([
        ["s1", 0.1],
        ["s2", 0.2],
        ["s3", 1],
      ]),
    );

    const withCorr = allocator.allocate(strategies, 100000, defaultConfig, correlations);
    const withoutCorr = allocator.allocate(strategies, 100000, defaultConfig);

    const corrGroupWith = withCorr
      .filter((a) => a.strategyId === "s1" || a.strategyId === "s2")
      .reduce((sum, a) => sum + a.capitalUsd, 0);
    const corrGroupWithout = withoutCorr
      .filter((a) => a.strategyId === "s1" || a.strategyId === "s2")
      .reduce((sum, a) => sum + a.capitalUsd, 0);

    expect(corrGroupWith).toBeLessThanOrEqual(corrGroupWithout);
  });

  it("provides allocation reasons", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 1.5 })];
    const result = allocator.allocate(strategies, 100000, defaultConfig);

    expect(result[0]!.reason).toContain("fitness=");
    expect(result[0]!.reason).toContain("level=");
    expect(result[0]!.reason).toContain("weight=");
  });
});
