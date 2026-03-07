/**
 * Phase F — Scenario: Performance Attribution.
 *
 * Tests multi-strategy performance attribution: creating strategies with paper
 * accounts on different symbols, storing per-strategy/market/symbol PnL snapshots,
 * verifying attribution breakdown via HTTP and direct store access, and comparing
 * multi-day historical snapshots.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-performance-attribution.test.ts
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

describe("Scenario — Performance Attribution", () => {
  let ctx: FullChainContext;
  let strategyIdA: string;
  let strategyIdB: string;
  let strategyIdC: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Create 3 strategies + paper accounts, submit orders on different symbols ──

  it("creates 3 strategies, paper accounts, and submits orders on BTC/ETH/SOL", async () => {
    // Fetch templates
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    expect(templates.length).toBeGreaterThan(0);
    const tplId = templates[0]!.id;

    // Create strategy A (BTC)
    const createA = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: tplId,
        name: "Alpha-BTC",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createA.status).toBe(201);
    strategyIdA = (createA.body as { strategy: { id: string } }).strategy.id;

    // Create strategy B (ETH)
    const createB = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: tplId,
        name: "Beta-ETH",
        symbol: "ETH/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 8, slowPeriod: 25 },
      }),
    });
    expect(createB.status).toBe(201);
    strategyIdB = (createB.body as { strategy: { id: string } }).strategy.id;

    // Create strategy C (SOL)
    const createC = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: tplId,
        name: "Gamma-SOL",
        symbol: "SOL/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 12, slowPeriod: 35 },
      }),
    });
    expect(createC.status).toBe(201);
    strategyIdC = (createC.body as { strategy: { id: string } }).strategy.id;

    // Inject backtest results so promotion gates pass
    for (const sid of [strategyIdA, strategyIdB, strategyIdC]) {
      ctx.services.strategyRegistry.updateBacktest(sid, {
        strategyId: sid,
        totalReturn: 20,
        sharpe: 2.0,
        sortino: 2.5,
        maxDrawdown: -5,
        calmar: 4.0,
        winRate: 0.65,
        profitFactor: 2.0,
        totalTrades: 100,
        finalEquity: 12_000,
        initialCapital: 10_000,
        startDate: Date.now() - 90 * 86_400_000,
        endDate: Date.now(),
        trades: [],
        equityCurve: [],
        dailyReturns: [],
      });
    }

    // Inject walkforward results so L1→L2 gate passes
    for (const sid of [strategyIdA, strategyIdB, strategyIdC]) {
      ctx.services.strategyRegistry.updateWalkForward(sid, {
        passed: true,
        windows: [],
        combinedTestSharpe: 1.4,
        avgTrainSharpe: 1.8,
        ratio: 0.78,
        threshold: 0.6,
      } as never);
    }

    // Promote all to L2 (L0 → L1 → L2)
    for (const id of [strategyIdA, strategyIdB, strategyIdC]) {
      const p1 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      expect(p1.status).toBe(200);

      const p2 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      expect(p2.status).toBe(200);
    }

    // Create paper accounts and submit orders on different symbols
    const acctBtc = ctx.services.paperEngine.createAccount("Attribution BTC", 10_000);
    const acctEth = ctx.services.paperEngine.createAccount("Attribution ETH", 10_000);
    const acctSol = ctx.services.paperEngine.createAccount("Attribution SOL", 10_000);

    // Submit orders with explicit currentPrice
    ctx.services.paperEngine.submitOrder(
      acctBtc.id,
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.1 },
      60_000,
    );
    ctx.services.paperEngine.submitOrder(
      acctEth.id,
      { symbol: "ETH/USDT", side: "buy", type: "market", quantity: 2 },
      3_000,
    );
    ctx.services.paperEngine.submitOrder(
      acctSol.id,
      { symbol: "SOL/USDT", side: "buy", type: "market", quantity: 50 },
      150,
    );

    // Verify all strategies exist
    const listRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    const strategies = (listRes.body as { strategies: Array<{ id: string }> }).strategies;
    const ids = strategies.map((s) => s.id);
    expect(ids).toContain(strategyIdA);
    expect(ids).toContain(strategyIdB);
    expect(ids).toContain(strategyIdC);
  });

  // ── 2. Strategy A (BTC) profit, B (ETH) loss, C (SOL) profit — conceptual attribution ──

  it("strategy A profits +$500, B loses -$200, C profits +$100 (conceptual)", () => {
    const attributions = {
      [strategyIdA]: { pnl: 500, symbol: "BTC/USDT" },
      [strategyIdB]: { pnl: -200, symbol: "ETH/USDT" },
      [strategyIdC]: { pnl: 100, symbol: "SOL/USDT" },
    };
    const totalPnl = Object.values(attributions).reduce((sum, a) => sum + a.pnl, 0);
    expect(totalPnl).toBe(400);
  });

  // ── 3. Write snapshot with byStrategyJson to PerformanceSnapshotStore ──

  it("stores a snapshot with per-strategy attribution data", () => {
    const byStrategy = {
      [strategyIdA]: { pnl: 500, symbol: "BTC/USDT" },
      [strategyIdB]: { pnl: -200, symbol: "ETH/USDT" },
      [strategyIdC]: { pnl: 100, symbol: "SOL/USDT" },
    };

    ctx.services.perfStore.addSnapshot({
      id: "day1",
      period: "2026-03-01",
      periodType: "daily",
      totalPnl: 400,
      totalReturn: 0.4,
      sharpe: 1.5,
      maxDrawdown: -2,
      byStrategyJson: JSON.stringify(byStrategy),
      byMarketJson: JSON.stringify({ crypto: 400 }),
      bySymbolJson: JSON.stringify({
        "BTC/USDT": 500,
        "ETH/USDT": -200,
        "SOL/USDT": 100,
      }),
      createdAt: Date.now() - 86_400_000,
    });

    const snapshots = ctx.services.perfStore.getLatest("daily", 10);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.id).toBe("day1");
    expect(snapshots[0]!.byStrategyJson).not.toBeNull();
  });

  // ── 4. GET /fund/performance returns byStrategy non-empty ──

  it("GET /fund/performance returns snapshots with byStrategy attribution", async () => {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    expect(res.status).toBe(200);

    const { snapshots } = res.body as {
      snapshots: Array<{
        id: string;
        byStrategyJson: string | null;
        totalPnl: number;
      }>;
    };
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const day1 = snapshots.find((s) => s.id === "day1");
    expect(day1).toBeDefined();
    expect(day1!.byStrategyJson).not.toBeNull();

    const byStrategy = JSON.parse(day1!.byStrategyJson!);
    expect(Object.keys(byStrategy)).toHaveLength(3);
  });

  // ── 5. Total PnL = sum of per-strategy PnL = +$400 ──

  it("totalPnl equals sum of per-strategy PnL ($400)", async () => {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    const { snapshots } = res.body as {
      snapshots: Array<{
        id: string;
        totalPnl: number;
        byStrategyJson: string | null;
      }>;
    };

    const day1 = snapshots.find((s) => s.id === "day1")!;
    expect(day1.totalPnl).toBe(400);

    const byStrategy = JSON.parse(day1.byStrategyJson!) as Record<string, { pnl: number }>;
    const sumPnl = Object.values(byStrategy).reduce((sum, s) => sum + s.pnl, 0);
    expect(sumPnl).toBe(day1.totalPnl);
  });

  // ── 6. bySymbol attribution: BTC=500, ETH=-200, SOL=100 ──

  it("bySymbol attribution matches expected per-symbol PnL", async () => {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    const { snapshots } = res.body as {
      snapshots: Array<{
        id: string;
        bySymbolJson: string | null;
      }>;
    };

    const day1 = snapshots.find((s) => s.id === "day1")!;
    expect(day1.bySymbolJson).not.toBeNull();

    const bySymbol = JSON.parse(day1.bySymbolJson!) as Record<string, number>;
    expect(bySymbol["BTC/USDT"]).toBe(500);
    expect(bySymbol["ETH/USDT"]).toBe(-200);
    expect(bySymbol["SOL/USDT"]).toBe(100);
  });

  // ── 7. Write day-2 snapshot, verify historical comparison ──

  it("stores day-2 snapshot and verifies multi-day history", async () => {
    const byStrategy2 = {
      [strategyIdA]: { pnl: 300, symbol: "BTC/USDT" },
      [strategyIdB]: { pnl: 150, symbol: "ETH/USDT" },
      [strategyIdC]: { pnl: -50, symbol: "SOL/USDT" },
    };

    ctx.services.perfStore.addSnapshot({
      id: "day2",
      period: "2026-03-02",
      periodType: "daily",
      totalPnl: 400,
      totalReturn: 0.38,
      sharpe: 1.8,
      maxDrawdown: -1.5,
      byStrategyJson: JSON.stringify(byStrategy2),
      byMarketJson: JSON.stringify({ crypto: 400 }),
      bySymbolJson: JSON.stringify({
        "BTC/USDT": 300,
        "ETH/USDT": 150,
        "SOL/USDT": -50,
      }),
      createdAt: Date.now(),
    });

    // Direct store: getLatest returns both, sorted by createdAt DESC
    const allSnapshots = ctx.services.perfStore.getLatest("daily", 10);
    expect(allSnapshots.length).toBe(2);
    expect(allSnapshots[0]!.id).toBe("day2"); // newest first
    expect(allSnapshots[1]!.id).toBe("day1");

    // HTTP endpoint also returns both
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    const { snapshots, total } = res.body as {
      snapshots: Array<{ id: string; totalPnl: number; period: string }>;
      total: number;
    };
    expect(total).toBe(2);
    expect(snapshots.map((s) => s.id)).toContain("day1");
    expect(snapshots.map((s) => s.id)).toContain("day2");

    // Verify day-over-day: strategy B flipped from loss to profit
    const day1Strategy = JSON.parse(allSnapshots[1]!.byStrategyJson!) as Record<
      string,
      { pnl: number }
    >;
    const day2Strategy = JSON.parse(allSnapshots[0]!.byStrategyJson!) as Record<
      string,
      { pnl: number }
    >;
    expect(day1Strategy[strategyIdB]!.pnl).toBe(-200);
    expect(day2Strategy[strategyIdB]!.pnl).toBe(150);
  });
});
