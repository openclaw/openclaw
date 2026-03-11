/**
 * Phase F — Scenario: Day 14-30 Paper Trading Monitoring Lifecycle.
 *
 * Exercises the full paper-trading monitoring flow: account creation,
 * strategy promotion to L2, order submission, position/order verification,
 * equity snapshots, performance snapshots, capital flows, and decay metrics.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-paper-monitoring.test.ts
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

describe("Scenario — Day 14-30 Paper Trading Monitoring", () => {
  let ctx: FullChainContext;
  let accountId: string;
  let strategyId: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Create paper account + L2 strategy ──

  it("creates a paper account and promotes a strategy to L2", async () => {
    // Create paper account
    const acct = ctx.services.paperEngine.createAccount("paper-monitor", 10_000);
    accountId = acct.id;
    expect(acct.id).toBeTruthy();
    expect(acct.initialCapital).toBe(10_000);
    expect(acct.cash).toBe(10_000);

    // Create strategy from template via API
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    expect(templates.length).toBeGreaterThan(0);

    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: templates[0]!.id,
        name: "Monitor Strategy Alpha",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (createRes.body as { strategy: { id: string; level: string } }).strategy;
    strategyId = created.id;
    expect(created.level).toBe("L0_INCUBATE");

    // Simulate Agent promoting L0 → L1 → L2 (LifecycleEngine no longer auto-promotes)
    ctx.services.strategyRegistry.updateLevel(strategyId, "L1_BACKTEST");
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER");
  });

  // ── 2. Submit 5 paper orders ──

  it("submits 5 paper orders for different symbols", async () => {
    const orders = [
      { symbol: "BTC/USDT", amount: 0.001, price: 50_000 },
      { symbol: "ETH/USDT", amount: 0.01, price: 3_000 },
      { symbol: "SOL/USDT", amount: 0.1, price: 150 },
      { symbol: "DOGE/USDT", amount: 10, price: 0.08 },
      { symbol: "XRP/USDT", amount: 1, price: 0.6 },
    ];

    for (const o of orders) {
      const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: o.symbol,
          side: "buy",
          type: "market",
          amount: o.amount,
          price: o.price,
          strategyId,
          accountId,
        }),
      });
      expect(status).toBe(201);
      const wrapper = body as { domain?: string; order: { status: string; symbol: string } };
      expect(wrapper.order.status).toBe("filled");
      expect(wrapper.order.symbol).toBe(o.symbol);
    }
  });

  // ── 3. Verify positions via service ──

  it("verifies positions exist after orders", () => {
    const state = ctx.services.paperEngine.getAccountState(accountId);
    expect(state).not.toBeNull();
    expect(state!.positions.length).toBeGreaterThan(0);

    // Each filled buy should create a position
    const symbols = state!.positions.map((p) => p.symbol);
    expect(symbols).toContain("BTC/USDT");
    expect(symbols).toContain("ETH/USDT");
  });

  // ── 4. Verify order history via service ──

  it("verifies at least 5 orders in history with filled status", () => {
    const orders = ctx.services.paperEngine.getOrders(accountId);
    expect(orders.length).toBeGreaterThanOrEqual(5);

    const filledOrders = orders.filter((o) => o.status === "filled");
    expect(filledOrders.length).toBeGreaterThanOrEqual(5);
  });

  // ── 5. Record equity snapshots ──

  it("records an equity snapshot and retrieves it", () => {
    ctx.services.paperEngine.recordSnapshot(accountId);

    const snapshots = ctx.services.paperEngine.getSnapshots(accountId);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const latest = snapshots[snapshots.length - 1]!;
    expect(latest.equity).toBeGreaterThan(0);
    expect(typeof latest.cash).toBe("number");
    expect(typeof latest.positionsValue).toBe("number");
    expect(latest.accountId).toBe(accountId);
  });

  // ── 6. Write performance snapshot to store ──

  it("writes a performance snapshot and verifies GET /fund/performance returns it", async () => {
    ctx.services.perfStore.addSnapshot({
      id: `perf-${Date.now()}`,
      period: new Date().toISOString().slice(0, 10),
      periodType: "daily",
      totalPnl: 150.5,
      totalReturn: 1.5,
      sharpe: 1.2,
      maxDrawdown: -3.5,
      byStrategyJson: JSON.stringify([{ id: strategyId, pnl: 150.5 }]),
      byMarketJson: null,
      bySymbolJson: null,
      createdAt: Date.now(),
    });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/performance`);
    expect(status).toBe(200);
    const data = body as { snapshots: Array<{ totalPnl: number }>; total: number };
    expect(data.snapshots.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThan(0);

    // Verify the snapshot we just added
    const found = data.snapshots.find((s) => s.totalPnl === 150.5);
    expect(found).toBeDefined();
  });

  // ── 7. Record capital flow ──

  it("records a capital flow and verifies GET /fund/capital-flows returns it", async () => {
    ctx.services.flowStore.record({
      id: `flow-${Date.now()}`,
      type: "deposit",
      amount: 5000,
      currency: "USD",
      status: "completed",
      description: "Initial seed capital top-up",
      createdAt: Date.now(),
    });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/capital-flows`);
    expect(status).toBe(200);
    const data = body as { flows: Array<{ type: string; amount: number }>; total: number };
    expect(data.flows.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThan(0);

    // Verify the flow we just added
    const found = data.flows.find((f) => f.amount === 5000 && f.type === "deposit");
    expect(found).toBeDefined();
  });

  // ── 8. Verify decay metrics ──

  it("returns decay metrics with expected DecayState fields", () => {
    const metrics = ctx.services.paperEngine.getMetrics(accountId);
    expect(metrics).not.toBeNull();

    // Verify all DecayState fields are present
    expect(typeof metrics!.rollingSharpe7d).toBe("number");
    expect(typeof metrics!.rollingSharpe30d).toBe("number");
    expect(typeof metrics!.decayLevel).toBe("string");
    expect(typeof metrics!.currentDrawdown).toBe("number");
    expect(typeof metrics!.peakEquity).toBe("number");

    // decayLevel must be one of the valid enum values
    expect(["healthy", "warning", "degrading", "critical"]).toContain(metrics!.decayLevel);
  });
});
