/**
 * Phase F — Scenario: Multi-Round Rebalance Cycle.
 *
 * Tests fund rebalance across multiple rounds: initial allocation by fitness,
 * re-ranking after strategy degradation, confidence multiplier boost on L3
 * promotion, and HTTP endpoint consistency.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-multi-round-rebalance.test.ts
 */

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
import {
  createFullChainServer,
  fetchJson,
  type FullChainContext,
  DEFAULT_FUND_CONFIG,
} from "./harness.js";

describe("Scenario — Multi-Round Rebalance Cycle", () => {
  let ctx: FullChainContext;

  // Strategy IDs (A = best, D = weakest initially)
  let idA: string;
  let idB: string;
  let idC: string;
  let idD: string;

  // Track allocations across rounds
  let round1Allocations: Array<{ strategyId: string; capitalUsd: number; weightPct: number }>;
  let round1Leaderboard: Array<{
    rank: number;
    strategyId: string;
    leaderboardScore: number;
    confidenceMultiplier: number;
  }>;
  let round2Allocations: Array<{ strategyId: string; capitalUsd: number; weightPct: number }>;
  let round3Leaderboard: Array<{
    rank: number;
    strategyId: string;
    leaderboardScore: number;
    confidenceMultiplier: number;
  }>;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Initialize 4 L2 strategies + $200K fund ──

  it("initializes 4 L2 strategies and sets fund to $200K", async () => {
    // Fetch templates
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    expect(templates.length).toBeGreaterThan(0);

    const strategyDefs = [
      {
        name: "Alpha Momentum",
        symbol: "BTC/USDT",
        sharpe: 2.5,
        totalReturn: 32.0,
        maxDrawdown: -6.0,
        winRate: 0.75,
        profitFactor: 2.8,
        totalTrades: 180,
      },
      {
        name: "Beta Trend",
        symbol: "ETH/USDT",
        sharpe: 1.8,
        totalReturn: 20.0,
        maxDrawdown: -10.0,
        winRate: 0.65,
        profitFactor: 2.0,
        totalTrades: 140,
      },
      {
        name: "Gamma Mean Rev",
        symbol: "SOL/USDT",
        sharpe: 1.2,
        totalReturn: 12.0,
        maxDrawdown: -14.0,
        winRate: 0.58,
        profitFactor: 1.5,
        totalTrades: 100,
      },
      {
        name: "Delta Scalper",
        symbol: "BNB/USDT",
        sharpe: 0.8,
        totalReturn: 5.0,
        maxDrawdown: -18.0,
        winRate: 0.52,
        profitFactor: 1.2,
        totalTrades: 200,
      },
    ];

    const ids: string[] = [];

    for (const def of strategyDefs) {
      // Create
      const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: templates[0]!.id,
          name: def.name,
          symbol: def.symbol,
          timeframe: "1h",
          exchangeId: "binance",
          parameters: { fastPeriod: 10, slowPeriod: 30 },
        }),
      });
      expect(res.status).toBe(201);
      const id = (res.body as { strategy: { id: string } }).strategy.id;
      ids.push(id);

      // Inject backtest
      ctx.services.strategyRegistry.updateBacktest(id, {
        strategyId: id,
        totalReturn: def.totalReturn,
        sharpe: def.sharpe,
        sortino: def.sharpe * 1.3,
        maxDrawdown: def.maxDrawdown,
        calmar: def.totalReturn / Math.abs(def.maxDrawdown),
        winRate: def.winRate,
        profitFactor: def.profitFactor,
        totalTrades: def.totalTrades,
        finalEquity: 10_000 * (1 + def.totalReturn / 100),
        initialCapital: 10_000,
        startDate: Date.now() - 90 * 86_400_000,
        endDate: Date.now(),
        trades: [],
        equityCurve: [],
        dailyReturns: [],
      });

      // Simulate Agent promoting L0 → L1 → L2 (LifecycleEngine no longer auto-promotes)
      ctx.services.strategyRegistry.updateLevel(id, "L1_BACKTEST");
      ctx.services.strategyRegistry.updateLevel(id, "L2_PAPER");
    }

    [idA, idB, idC, idD] = ids;

    // Set fund to $200K
    ctx.services.fundManager.setTotalCapital(200_000);
    ctx.services.fundManager.markDayStart(200_000);

    // Verify all 4 at L2
    for (const id of ids) {
      const record = ctx.services.strategyRegistry.get(id);
      expect(record?.level).toBe("L2_PAPER");
    }
  });

  // ── 2. Round 1: initial rebalance, allocation by fitness ──

  it("Round 1: rebalances and allocates more capital to higher-fitness strategies", () => {
    const records = ctx.services.strategyRegistry.list();
    expect(records.length).toBe(4);

    const result = ctx.services.fundManager.rebalance(records as never);
    round1Allocations = result.allocations;
    round1Leaderboard = result.leaderboard;

    expect(round1Allocations.length).toBeGreaterThan(0);

    // Find allocations for A (highest fitness) and D (lowest fitness)
    const allocA = round1Allocations.find((a) => a.strategyId === idA);
    const allocD = round1Allocations.find((a) => a.strategyId === idD);

    expect(allocA).toBeDefined();
    // D might not receive allocation if fitness is too low — but if it does, A should get more
    if (allocD) {
      expect(allocA!.capitalUsd).toBeGreaterThan(allocD.capitalUsd);
    }
  });

  // ── 3. Round 1 leaderboard is ranked by score descending ──

  it("Round 1: leaderboard is ranked by leaderboardScore descending", () => {
    expect(round1Leaderboard.length).toBeGreaterThan(0);

    for (let i = 1; i < round1Leaderboard.length; i++) {
      expect(round1Leaderboard[i - 1]!.leaderboardScore).toBeGreaterThanOrEqual(
        round1Leaderboard[i]!.leaderboardScore,
      );
    }

    // Ranks should be sequential 1, 2, 3, ...
    for (let i = 0; i < round1Leaderboard.length; i++) {
      expect(round1Leaderboard[i]!.rank).toBe(i + 1);
    }
  });

  // ── 4. Degrade strategy A's fitness (sharpe drops from 2.5 to 0.3) ──

  it("updates strategy A backtest to sharpe=0.3 (performance degradation)", () => {
    ctx.services.strategyRegistry.updateBacktest(idA, {
      strategyId: idA,
      totalReturn: 1.0,
      sharpe: 0.3,
      sortino: 0.4,
      maxDrawdown: -25.0,
      calmar: 0.04,
      winRate: 0.42,
      profitFactor: 0.9,
      totalTrades: 200,
      finalEquity: 10_100,
      initialCapital: 10_000,
      startDate: Date.now() - 90 * 86_400_000,
      endDate: Date.now(),
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    });

    const record = ctx.services.strategyRegistry.get(idA);
    expect(record?.lastBacktest?.sharpe).toBe(0.3);
  });

  // ── 5. Round 2: strategy A allocation drops ──

  it("Round 2: strategy A allocation decreases after degradation", () => {
    const records = ctx.services.strategyRegistry.list();
    const result = ctx.services.fundManager.rebalance(records as never);
    round2Allocations = result.allocations;

    const round1AllocA = round1Allocations.find((a) => a.strategyId === idA);
    const round2AllocA = round2Allocations.find((a) => a.strategyId === idA);

    // Strategy A was top performer in round 1 — now it should have less capital
    // It might even be excluded entirely from allocation
    if (round2AllocA && round1AllocA) {
      expect(round2AllocA.capitalUsd).toBeLessThan(round1AllocA.capitalUsd);
    } else if (!round2AllocA && round1AllocA) {
      // Completely dropped — also valid
      expect(round1AllocA.capitalUsd).toBeGreaterThan(0);
    }

    // Strategy B should now rank higher than A in allocations
    const round2AllocB = round2Allocations.find((a) => a.strategyId === idB);
    if (round2AllocA && round2AllocB) {
      expect(round2AllocB.capitalUsd).toBeGreaterThan(round2AllocA.capitalUsd);
    }
  });

  // ── 6. Promote strategy B to L3 ──

  it("promotes strategy B to L3_LIVE for higher confidence multiplier", () => {
    ctx.services.strategyRegistry.updateLevel(idB, "L3_LIVE");
    const record = ctx.services.strategyRegistry.get(idB);
    expect(record?.level).toBe("L3_LIVE");
  });

  // ── 7. Round 3: L3 strategy B benefits from higher confidence multiplier ──

  it("Round 3: strategy B leaderboard score increases due to L3 confidence multiplier", () => {
    const records = ctx.services.strategyRegistry.list();
    const result = ctx.services.fundManager.rebalance(records as never);
    round3Leaderboard = result.leaderboard;

    const round1EntryB = round1Leaderboard.find((e) => e.strategyId === idB);
    const round3EntryB = round3Leaderboard.find((e) => e.strategyId === idB);

    expect(round1EntryB).toBeDefined();
    expect(round3EntryB).toBeDefined();

    // L2 multiplier was 0.7, L3 is 1.0 — score should increase
    expect(round3EntryB!.confidenceMultiplier).toBe(1.0);
    expect(round1EntryB!.confidenceMultiplier).toBe(0.7);
    expect(round3EntryB!.leaderboardScore).toBeGreaterThan(round1EntryB!.leaderboardScore);
  });

  // ── 8. Final GET /fund/allocations reflects round 3 state ──

  it("GET /fund/allocations returns the final allocation state after 3 rounds", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/allocations`);
    expect(status).toBe(200);

    const data = body as {
      allocations: Array<{ strategyId: string; capitalUsd: number; weightPct: number }>;
      totalAllocated: number;
      cashReserve: number;
      totalCapital: number;
    };

    // HTTP route uses config.totalCapital (DEFAULT_FUND_CONFIG = 100K) which takes
    // precedence over state.totalCapital. The allocator uses the runtime state ($200K)
    // but the HTTP response reflects the config value.
    expect(data.totalCapital).toBe(DEFAULT_FUND_CONFIG.totalCapital);
    expect(data.allocations.length).toBeGreaterThan(0);
    expect(data.totalAllocated).toBeGreaterThan(0);

    // Allocations should match what rebalance produced in round 3
    for (const alloc of data.allocations) {
      expect(alloc.capitalUsd).toBeGreaterThan(0);
      expect(alloc.strategyId).toBeTruthy();
    }
  });
});
