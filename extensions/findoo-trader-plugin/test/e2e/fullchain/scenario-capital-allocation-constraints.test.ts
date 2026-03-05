vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StrategyProfile } from "../../../src/fund/types.js";
import { createFullChainServer, type FullChainContext, DEFAULT_FUND_CONFIG } from "./harness.js";

// ── Helpers ──

function makeProfile(
  overrides: Partial<StrategyProfile> & { id: string; name: string },
): StrategyProfile {
  return { level: "L2_PAPER", fitness: 1.0, ...overrides };
}

function sumWeightPct(allocs: Array<{ weightPct: number }>): number {
  return allocs.reduce((s, a) => s + a.weightPct, 0);
}

// ── Suite ──

describe("Scenario: Capital Allocation Constraints", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 30_000);

  afterAll(() => ctx?.cleanup());

  const config = DEFAULT_FUND_CONFIG;
  const totalCapital = config.totalCapital; // 100_000

  // 1. 单策略 fitness=3.0 → 分配不超过 maxSinglePct (30%)
  it("single strategy weight capped at maxSingleStrategyPct (30%)", () => {
    const profiles = [makeProfile({ id: "s1", name: "solo-high-fit", fitness: 3.0 })];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    expect(allocs).toHaveLength(1);
    expect(allocs[0].weightPct).toBeLessThanOrEqual(config.maxSingleStrategyPct);
    expect(allocs[0].capitalUsd).toBeLessThanOrEqual(
      totalCapital * (config.maxSingleStrategyPct / 100),
    );
  });

  // 2. 5 策略总分配 ≤ maxTotalExposure (70%)
  it("total allocation of 5 strategies stays within maxTotalExposurePct (70%)", () => {
    const profiles = [
      makeProfile({ id: "a1", name: "alpha", fitness: 2.5 }),
      makeProfile({ id: "a2", name: "beta", fitness: 1.8 }),
      makeProfile({ id: "a3", name: "gamma", fitness: 1.2 }),
      makeProfile({ id: "a4", name: "delta", fitness: 0.9 }),
      makeProfile({ id: "a5", name: "epsilon", fitness: 0.6 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    expect(allocs.length).toBeGreaterThanOrEqual(1);
    expect(sumWeightPct(allocs)).toBeLessThanOrEqual(config.maxTotalExposurePct + 0.01); // float tolerance
  });

  // 3. 新晋 L3 策略 (<30d) 分配 ≤ 10%
  it("new L3 strategy (<30 days) capped at 10%", () => {
    const profiles = [
      makeProfile({
        id: "l3new",
        name: "l3-newbie",
        level: "L3_LIVE",
        fitness: 2.0,
        paperDaysActive: 10,
      }),
      makeProfile({ id: "l2base", name: "l2-anchor", fitness: 1.0 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);
    const l3Alloc = allocs.find((a) => a.strategyId === "l3new");

    expect(l3Alloc).toBeDefined();
    expect(l3Alloc!.weightPct).toBeLessThanOrEqual(10);
  });

  // 4. L2 paper 策略分配 ≤ 15%
  it("L2_PAPER strategy capped at 15%", () => {
    const profiles = [
      makeProfile({ id: "l2only", name: "paper-strat", level: "L2_PAPER", fitness: 5.0 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    expect(allocs).toHaveLength(1);
    expect(allocs[0].weightPct).toBeLessThanOrEqual(15);
  });

  // 5. 高相关组 (|r|≥0.7) 合计 ≤ 40%
  it("high-correlation group (|r|>=0.7) total weight ≤ 40%", () => {
    const profiles = [
      makeProfile({ id: "c1", name: "corr-a", fitness: 2.0 }),
      makeProfile({ id: "c2", name: "corr-b", fitness: 2.0 }),
      makeProfile({ id: "c3", name: "corr-c", fitness: 2.0 }),
    ];

    // Build symmetric correlation matrix: c1-c2=0.85, c1-c3=0.75, c2-c3=0.80
    const corr = new Map<string, Map<string, number>>();
    corr.set(
      "c1",
      new Map([
        ["c2", 0.85],
        ["c3", 0.75],
      ]),
    );
    corr.set(
      "c2",
      new Map([
        ["c1", 0.85],
        ["c3", 0.8],
      ]),
    );
    corr.set(
      "c3",
      new Map([
        ["c1", 0.75],
        ["c2", 0.8],
      ]),
    );

    const allocs = ctx.services.fundManager.allocator.allocate(
      profiles,
      totalCapital,
      config,
      corr,
    );

    // All three are in one highly-correlated group → combined ≤ 40%
    const groupWeight = sumWeightPct(allocs);
    expect(groupWeight).toBeLessThanOrEqual(40 + 0.01); // float tolerance
  });

  // 6. fitness=0 策略分配 = 0
  it("strategy with fitness=0 receives no allocation", () => {
    const profiles = [
      makeProfile({ id: "zero", name: "zero-fit", fitness: 0 }),
      makeProfile({ id: "pos", name: "positive", fitness: 1.0 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    const zeroAlloc = allocs.find((a) => a.strategyId === "zero");
    expect(zeroAlloc).toBeUndefined();
    expect(allocs.length).toBe(1);
    expect(allocs[0].strategyId).toBe("pos");
  });

  // 7. 所有策略 fitness 相等 → 均匀分配
  it("equal fitness produces roughly equal allocations", () => {
    const profiles = [
      makeProfile({ id: "eq1", name: "equal-1", fitness: 1.0 }),
      makeProfile({ id: "eq2", name: "equal-2", fitness: 1.0 }),
      makeProfile({ id: "eq3", name: "equal-3", fitness: 1.0 }),
      makeProfile({ id: "eq4", name: "equal-4", fitness: 1.0 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    expect(allocs).toHaveLength(4);
    const weights = allocs.map((a) => a.weightPct);
    const avg = weights.reduce((s, w) => s + w, 0) / weights.length;
    // Each weight should be within 1% of the average
    for (const w of weights) {
      expect(Math.abs(w - avg)).toBeLessThan(1);
    }
  });

  // 8. $10K 小资金 + 5 策略 → 最小分配额验证
  it("small capital ($10K) with 5 strategies still produces positive allocations", () => {
    const smallCapital = 10_000;
    const profiles = [
      makeProfile({ id: "sm1", name: "small-1", fitness: 1.5 }),
      makeProfile({ id: "sm2", name: "small-2", fitness: 1.2 }),
      makeProfile({ id: "sm3", name: "small-3", fitness: 1.0 }),
      makeProfile({ id: "sm4", name: "small-4", fitness: 0.8 }),
      makeProfile({ id: "sm5", name: "small-5", fitness: 0.5 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, smallCapital, config);

    expect(allocs.length).toBeGreaterThanOrEqual(1);
    for (const a of allocs) {
      expect(a.capitalUsd).toBeGreaterThan(0);
    }
  });

  // 9. cash reserve = 100% - totalAllocation ≥ 30%
  it("cash reserve (100% - totalAllocation) is at least cashReservePct (30%)", () => {
    const profiles = [
      makeProfile({ id: "r1", name: "reserve-1", fitness: 3.0 }),
      makeProfile({ id: "r2", name: "reserve-2", fitness: 2.5 }),
      makeProfile({ id: "r3", name: "reserve-3", fitness: 2.0 }),
      makeProfile({ id: "r4", name: "reserve-4", fitness: 1.5 }),
      makeProfile({ id: "r5", name: "reserve-5", fitness: 1.0 }),
    ];
    const allocs = ctx.services.fundManager.allocator.allocate(profiles, totalCapital, config);

    const totalExposure = sumWeightPct(allocs);
    const cashReserve = 100 - totalExposure;
    expect(cashReserve).toBeGreaterThanOrEqual(config.cashReservePct - 0.01); // float tolerance
  });
});
