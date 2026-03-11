/**
 * Phase F — Scenario: Emergency Recovery (Crisis Response + Recovery)
 *
 * Tests the full emergency stop -> verify blocked -> recovery -> resume cycle.
 * All 5 tests share state and run sequentially, building upon each other.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-emergency-recovery.test.ts
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

import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

describe("Phase F — Scenario: Emergency Recovery", () => {
  let ctx: FullChainContext;
  let strategyIdA: string;
  let strategyIdB: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Setup active fund state ──
  it("sets up active fund state with paper account, 2 running strategies, and a paper order", async () => {
    // Create a paper account with $20,000
    const acct = ctx.services.paperEngine.createAccount("crisis-account", 20_000);
    expect(acct.id).toBeTruthy();

    // Create strategy A via API
    const createA = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Crisis Strategy A",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createA.status).toBe(201);
    strategyIdA = (createA.body as { strategy: { id: string } }).strategy.id;

    // Create strategy B via API
    const createB = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "rsi-mean-reversion",
        name: "Crisis Strategy B",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { rsiPeriod: 14, oversold: 30, overbought: 70 },
      }),
    });
    expect(createB.status).toBe(201);
    strategyIdB = (createB.body as { strategy: { id: string } }).strategy.id;

    // Simulate Agent promoting L0 → L1 → L2 (LifecycleEngine no longer auto-promotes)
    for (const sid of [strategyIdA, strategyIdB]) {
      ctx.services.strategyRegistry.updateLevel(sid, "L1_BACKTEST");
      ctx.services.strategyRegistry.updateLevel(sid, "L2_PAPER");
    }

    // Set both strategies to "running" status
    ctx.services.strategyRegistry.updateStatus(strategyIdA, "running");
    ctx.services.strategyRegistry.updateStatus(strategyIdB, "running");

    // Place a small paper order (auto tier) to create active positions
    const orderRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.5,
        price: 10,
        reason: "crisis test position",
        accountId: acct.id,
      }),
    });
    expect(orderRes.status).toBe(201);

    // Verify both strategies are "running"
    const stratA = ctx.services.strategyRegistry.get(strategyIdA);
    const stratB = ctx.services.strategyRegistry.get(strategyIdB);
    expect(stratA?.status).toBe("running");
    expect(stratB?.status).toBe("running");
  });

  // ── 2. ESTOP blocks everything ──
  it("POST /emergency-stop pauses all strategies and disables trading", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/emergency-stop`, {
      method: "POST",
    });

    expect(status).toBe(200);
    const data = body as {
      status: string;
      tradingDisabled: boolean;
      strategiesPaused: string[];
      message: string;
    };
    expect(data.status).toBe("stopped");
    expect(data.tradingDisabled).toBe(true);
    expect(data.strategiesPaused).toContain(strategyIdA);
    expect(data.strategiesPaused).toContain(strategyIdB);
    expect(data.message).toMatch(/emergency stop/i);

    // Verify GET /events has an emergency_stop event
    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    expect(eventsRes.status).toBe(200);
    const evData = eventsRes.body as { events: Array<{ type: string; title: string }> };
    const emergencyEvent = evData.events.find((e) => e.type === "emergency_stop");
    expect(emergencyEvent).toBeDefined();
    expect(emergencyEvent!.title).toBe("EMERGENCY STOP ACTIVATED");
  });

  // ── 3. Verify strategies are paused; orders rejected after ESTOP ──
  it("strategies are paused and new orders are rejected after ESTOP", async () => {
    // Verify strategies are paused via the API
    const stratRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(stratRes.status).toBe(200);
    const strategies = (stratRes.body as { strategies: Array<{ id: string; status?: string }> })
      .strategies;
    const stratA = strategies.find((s) => s.id === strategyIdA);
    const stratB = strategies.find((s) => s.id === strategyIdB);
    expect(stratA?.status).toBe("paused");
    expect(stratB?.status).toBe("paused");

    // After ESTOP, risk controller has enabled=false.
    // When enabled=false, evaluate() returns tier="reject", so orders should be blocked.
    const orderRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.5,
        price: 10,
        reason: "attempt after estop",
      }),
    });
    // Risk controller with enabled=false returns "reject" tier -> 403
    expect(orderRes.status).toBe(403);
    const orderData = orderRes.body as { error: string };
    expect(orderData.error).toMatch(/disabled/i);
  });

  // ── 4. Recovery: re-enable risk + resume strategies ──
  it("recovery re-enables risk controller and resumes all strategies", async () => {
    // Re-enable trading via PUT /config/trading
    const configRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/trading`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      }),
    });
    expect(configRes.status).toBe(200);
    const configData = configRes.body as { status: string; config: { enabled: boolean } };
    expect(configData.status).toBe("updated");
    expect(configData.config.enabled).toBe(true);

    // Resume both strategies
    for (const sid of [strategyIdA, strategyIdB]) {
      const resumeRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sid }),
      });
      expect(resumeRes.status).toBe(200);
      const resumeData = resumeRes.body as { status: string; id: string };
      expect(resumeData.status).toBe("running");
      expect(resumeData.id).toBe(sid);
    }

    // Verify both strategies are running again
    const stratRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    const strategies = (stratRes.body as { strategies: Array<{ id: string; status?: string }> })
      .strategies;
    const stratA = strategies.find((s) => s.id === strategyIdA);
    const stratB = strategies.find((s) => s.id === strategyIdB);
    expect(stratA?.status).toBe("running");
    expect(stratB?.status).toBe("running");
  });

  // ── 5. Post-recovery order flow works normally ──
  it("post-recovery order flow works: auto, confirm, and risk evaluation", async () => {
    // Small order (auto tier): quantity=1, price=10 -> $10 <= maxAutoTradeUsd(100) -> auto -> 201
    const smallOrder = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 1,
        price: 10,
        reason: "post-recovery small order",
      }),
    });
    expect(smallOrder.status).toBe(201);
    const smallWrapper = smallOrder.body as {
      domain?: string;
      order: { status: string; symbol: string };
    };
    expect(smallWrapper.order.symbol).toBe("BTC/USDT");
    expect(smallWrapper.order.status).toBe("filled");

    // Medium order (confirm tier): quantity=3, price=200 -> $600
    // $100 < $600 <= $1000 -> confirm tier -> 202
    const mediumOrder = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "ETH/USDT",
        side: "buy",
        type: "market",
        amount: 3,
        price: 200,
        reason: "post-recovery medium order",
      }),
    });
    expect(mediumOrder.status).toBe(202);
    const mediumData = mediumOrder.body as { status: string; eventId: string };
    expect(mediumData.status).toBe("pending_approval");
    expect(mediumData.eventId).toBeTruthy();

    // Verify risk evaluation is back to normal
    const riskRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/risk/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        estimatedValueUsd: 50,
      }),
    });
    expect(riskRes.status).toBe(200);
    const riskData = riskRes.body as { tier: string };
    expect(riskData.tier).toBe("auto");
  });
});
