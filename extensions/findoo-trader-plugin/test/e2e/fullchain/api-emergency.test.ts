/**
 * Phase F — B9: Emergency stop & risk evaluation full-chain E2E tests.
 * Validates /api/v1/finance/emergency-stop and /api/v1/finance/risk/evaluate endpoints.
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

describe("B9 — Emergency stop & risk evaluation full-chain", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  it("POST /emergency-stop disables trading", async () => {
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
    expect(typeof data.message).toBe("string");
  });

  it("POST /emergency-stop pauses all active strategies", async () => {
    // Re-enable trading first (emergency-stop disables it)
    ctx.services.riskController.updateConfig({ enabled: true });

    // Create some strategies via the registry
    ctx.services.strategyRegistry.create({
      id: "test-strat-1",
      name: "Test Strategy 1",
      version: "1.0.0",
      market: "crypto",
      timeframe: "1h",
      indicators: [],
      rules: [],
    });
    ctx.services.strategyRegistry.create({
      id: "test-strat-2",
      name: "Test Strategy 2",
      version: "1.0.0",
      market: "crypto",
      timeframe: "1h",
      indicators: [],
      rules: [],
    });

    // Set them to "running" status
    ctx.services.strategyRegistry.updateStatus("test-strat-1", "running");
    ctx.services.strategyRegistry.updateStatus("test-strat-2", "running");

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/emergency-stop`, {
      method: "POST",
    });
    expect(status).toBe(200);
    const data = body as {
      status: string;
      tradingDisabled: boolean;
      strategiesPaused: string[];
    };
    expect(data.status).toBe("stopped");
    expect(data.strategiesPaused).toContain("test-strat-1");
    expect(data.strategiesPaused).toContain("test-strat-2");
  });

  it("POST /emergency-stop records event in eventStore", async () => {
    // Re-enable trading
    ctx.services.riskController.updateConfig({ enabled: true });

    const eventCountBefore = ctx.services.eventStore.listEvents().length;

    await fetchJson(`${ctx.baseUrl}/api/v1/finance/emergency-stop`, {
      method: "POST",
    });

    const events = ctx.services.eventStore.listEvents();
    expect(events.length).toBeGreaterThan(eventCountBefore);

    // The most recent event (listEvents returns newest first) should be the emergency stop
    const emergencyEvent = events.find((e) => e.type === "emergency_stop");
    expect(emergencyEvent).toBeDefined();
    expect(emergencyEvent!.title).toBe("EMERGENCY STOP ACTIVATED");
    expect(emergencyEvent!.status).toBe("completed");
  });

  it("POST /risk/evaluate small amount (50 USD) returns tier auto", async () => {
    // Re-enable trading for risk evaluation
    ctx.services.riskController.updateConfig({ enabled: true });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/risk/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        estimatedValueUsd: 50,
      }),
    });
    expect(status).toBe(200);
    const data = body as { tier: string; reason?: string };
    expect(data.tier).toBe("auto");
  });

  it("POST /risk/evaluate medium amount (500 USD) returns tier confirm", async () => {
    ctx.services.riskController.updateConfig({ enabled: true });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/risk/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.01,
        estimatedValueUsd: 500,
      }),
    });
    expect(status).toBe(200);
    const data = body as { tier: string; reason?: string };
    expect(data.tier).toBe("confirm");
    expect(data.reason).toBeDefined();
  });

  it("POST /risk/evaluate large amount (5000 USD) returns tier reject", async () => {
    ctx.services.riskController.updateConfig({ enabled: true });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/risk/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.1,
        estimatedValueUsd: 5000,
      }),
    });
    expect(status).toBe(200);
    const data = body as { tier: string; reason?: string };
    expect(data.tier).toBe("reject");
    expect(data.reason).toBeDefined();
  });
});
