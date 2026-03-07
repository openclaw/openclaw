/**
 * Phase F — Scenario: Monthly Performance Review.
 *
 * Tests fund management with actual strategy data: creating strategies with
 * backtest results, leaderboard ranking, capital allocation, fund status
 * reflecting active strategies, and the full rebalance cycle.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-fund-with-data.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import {
  createFullChainServer,
  fetchJson,
  type FullChainContext,
  DEFAULT_FUND_CONFIG,
} from "./harness.js";

describe("Scenario — Monthly Performance Review (Fund with Data)", () => {
  let ctx: FullChainContext;
  let strategyId1: string;
  let strategyId2: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Create 2 strategies with backtest results and promote to L2 ──

  it("creates 2 strategies with backtest results and promotes both to L2", async () => {
    // Fetch templates
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    expect(templates.length).toBeGreaterThan(0);

    // Create strategy 1 (high performer)
    const create1 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: templates[0]!.id,
        name: "High Sharpe Alpha",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(create1.status).toBe(201);
    strategyId1 = (create1.body as { strategy: { id: string } }).strategy.id;

    // Create strategy 2 (moderate performer)
    const create2 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: templates[0]!.id,
        name: "Moderate Momentum Beta",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { fastPeriod: 5, slowPeriod: 20 },
      }),
    });
    expect(create2.status).toBe(201);
    strategyId2 = (create2.body as { strategy: { id: string } }).strategy.id;

    // Inject backtest results directly via the registry service
    ctx.services.strategyRegistry.updateBacktest(strategyId1, {
      strategyId: strategyId1,
      totalReturn: 25.5,
      sharpe: 2.1,
      sortino: 2.8,
      maxDrawdown: -8.5,
      calmar: 3.0,
      winRate: 0.72,
      profitFactor: 2.3,
      totalTrades: 156,
      finalEquity: 12_550,
      initialCapital: 10_000,
      startDate: Date.now() - 90 * 86_400_000,
      endDate: Date.now(),
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    });

    ctx.services.strategyRegistry.updateBacktest(strategyId2, {
      strategyId: strategyId2,
      totalReturn: 8.2,
      sharpe: 0.9,
      sortino: 1.1,
      maxDrawdown: -15.3,
      calmar: 0.5,
      winRate: 0.55,
      profitFactor: 1.4,
      totalTrades: 89,
      finalEquity: 10_820,
      initialCapital: 10_000,
      startDate: Date.now() - 90 * 86_400_000,
      endDate: Date.now(),
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    });

    // Simulate Agent promoting L0 → L1 → L2 (LifecycleEngine no longer auto-promotes)
    for (const id of [strategyId1, strategyId2]) {
      ctx.services.strategyRegistry.updateLevel(id, "L1_BACKTEST");
      ctx.services.strategyRegistry.updateLevel(id, "L2_PAPER");
    }

    // Verify both are at L2
    const record1 = ctx.services.strategyRegistry.get(strategyId1);
    const record2 = ctx.services.strategyRegistry.get(strategyId2);
    expect(record1?.level).toBe("L2_PAPER");
    expect(record2?.level).toBe("L2_PAPER");
  });

  // ── 2. GET /fund/leaderboard returns ranked strategies ──

  it("GET /fund/leaderboard returns ranked strategies with high-sharpe strategy on top", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/leaderboard`);
    expect(status).toBe(200);

    const data = body as {
      leaderboard: Array<{
        rank: number;
        strategyId: string;
        strategyName: string;
        fitness: number;
        sharpe: number;
      }>;
      total: number;
    };

    expect(data.leaderboard.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThan(0);

    // Strategy 1 (sharpe=2.1) should rank above strategy 2 (sharpe=0.9)
    const idx1 = data.leaderboard.findIndex((e) => e.strategyId === strategyId1);
    const idx2 = data.leaderboard.findIndex((e) => e.strategyId === strategyId2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
  });

  // ── 3. Run fund allocation via service ──

  it("builds profiles and allocates capital with non-empty allocations", () => {
    const records = ctx.services.strategyRegistry.list();
    expect(records.length).toBeGreaterThanOrEqual(2);

    const profiles = ctx.services.fundManager.buildProfiles(records as never);
    expect(profiles.length).toBeGreaterThan(0);

    const allocations = ctx.services.fundManager.allocate(profiles);
    expect(allocations.length).toBeGreaterThan(0);

    for (const alloc of allocations) {
      expect(alloc.strategyId).toBeTruthy();
      expect(alloc.capitalUsd).toBeGreaterThan(0);
      expect(typeof alloc.weightPct).toBe("number");
    }
  });

  // ── 4. GET /fund/allocations returns non-empty allocations ──

  it("GET /fund/allocations returns persisted allocations after allocation", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/allocations`);
    expect(status).toBe(200);

    const data = body as {
      allocations: Array<{ strategyId: string; capitalUsd: number }>;
      totalAllocated: number;
      cashReserve: number;
      totalCapital: number;
    };

    expect(data.allocations.length).toBeGreaterThan(0);
    expect(data.totalAllocated).toBeGreaterThan(0);
    expect(data.cashReserve).toBeLessThan(data.totalCapital);
    expect(data.totalCapital).toBe(DEFAULT_FUND_CONFIG.totalCapital);

    // Each allocation should have positive capital
    for (const alloc of data.allocations) {
      expect(alloc.capitalUsd).toBeGreaterThan(0);
    }
  });

  // ── 5. GET /fund/status reflects active strategies ──

  it("GET /fund/status reflects L2_PAPER strategies in byLevel", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/status`);
    expect(status).toBe(200);

    const data = body as {
      totalEquity: number;
      byLevel: {
        L3_LIVE: number;
        L2_PAPER: number;
        L1_BACKTEST: number;
        L0_INCUBATE: number;
        KILLED: number;
      };
      allocationCount: number;
    };

    // Both strategies are at L2_PAPER
    expect(data.byLevel.L2_PAPER).toBeGreaterThanOrEqual(2);
    expect(data.allocationCount).toBeGreaterThan(0);
    expect(data.totalEquity).toBe(DEFAULT_FUND_CONFIG.totalCapital);
  });

  // ── 6. Fund rebalance cycle ──

  it("runs a full rebalance cycle with allocations, leaderboard, and risk", () => {
    const records = ctx.services.strategyRegistry.list();
    expect(records.length).toBeGreaterThanOrEqual(2);

    const result = ctx.services.fundManager.rebalance(records as never);

    // Allocations
    expect(result.allocations).toBeDefined();
    expect(result.allocations.length).toBeGreaterThan(0);
    for (const alloc of result.allocations) {
      expect(alloc.strategyId).toBeTruthy();
      expect(alloc.capitalUsd).toBeGreaterThan(0);
    }

    // Leaderboard
    expect(result.leaderboard).toBeDefined();
    expect(result.leaderboard.length).toBeGreaterThan(0);
    for (const entry of result.leaderboard) {
      expect(entry.rank).toBeGreaterThan(0);
      expect(entry.strategyId).toBeTruthy();
      expect(typeof entry.fitness).toBe("number");
    }

    // Risk
    expect(result.risk).toBeDefined();
    expect(typeof result.risk.riskLevel).toBe("string");
    expect(["normal", "caution", "warning", "critical"]).toContain(result.risk.riskLevel);
    expect(typeof result.risk.dailyDrawdown).toBe("number");
    expect(typeof result.risk.totalEquity).toBe("number");

    // Promotions and demotions arrays exist (may be empty)
    expect(Array.isArray(result.promotions)).toBe(true);
    expect(Array.isArray(result.demotions)).toBe(true);
  });
});
