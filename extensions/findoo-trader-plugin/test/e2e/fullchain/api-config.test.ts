/**
 * Phase F — B1: Config & Setting API full-chain E2E tests.
 * Tests GET /config, PUT /config/trading, PUT /config/agent,
 * PUT /config/gates, GET /exchange-health against real services.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000, BTC: 0.5 } }));
    fetchMarkets = vi.fn(async () => [{ id: "BTCUSDT", symbol: "BTC/USDT" }]);
    fetchOrderBook = vi.fn(async () => ({
      bids: [
        [65000, 1.5],
        [64900, 2.0],
      ],
      asks: [
        [65100, 1.2],
        [65200, 0.8],
      ],
      timestamp: Date.now(),
    }));
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

describe("Phase F — Config & Setting API (B1)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // 1. GET /config returns financial config with generatedAt
  it("GET /config returns financial config with generatedAt", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config`);
    expect(status).toBe(200);

    const data = body as Record<string, unknown>;
    expect(data.generatedAt).toBeDefined();
    expect(typeof data.generatedAt).toBe("string");
    expect(data.exchanges).toBeDefined();
    expect(data.trading).toBeDefined();
    expect(data.plugins).toBeDefined();
  });

  // 2. PUT /config/trading updates risk config
  it("PUT /config/trading updates risk config", async () => {
    const payload = {
      enabled: true,
      maxAutoTradeUsd: 200,
      confirmThresholdUsd: 2000,
      maxDailyLossUsd: 8000,
      maxPositionPct: 25,
      maxLeverage: 5,
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/trading`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(200);
    const data = body as { status: string; config: Record<string, unknown> };
    expect(data.status).toBe("updated");
    expect(data.config.maxAutoTradeUsd).toBe(200);
    expect(data.config.confirmThresholdUsd).toBe(2000);
    expect(data.config.maxDailyLossUsd).toBe(8000);
    expect(data.config.maxPositionPct).toBe(25);
    expect(data.config.maxLeverage).toBe(5);
  });

  // 3. PUT /config/trading validation: maxAuto > confirm -> 400
  it("PUT /config/trading rejects maxAutoTradeUsd > confirmThresholdUsd", async () => {
    const payload = {
      enabled: true,
      maxAutoTradeUsd: 5000,
      confirmThresholdUsd: 1000, // less than maxAutoTradeUsd — invalid
      maxDailyLossUsd: 5000,
      maxPositionPct: 20,
      maxLeverage: 10,
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/trading`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toMatch(/maxAutoTradeUsd must be less than confirmThresholdUsd/);
  });

  // 4. PUT /config/agent updates agent behavior
  it("PUT /config/agent updates agent behavior config", async () => {
    const payload = {
      heartbeatIntervalMs: 30000,
      discoveryEnabled: false,
      evolutionEnabled: true,
      mutationRate: 0.25,
      maxConcurrentStrategies: 10,
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(200);
    const data = body as { status: string; config: Record<string, unknown> };
    expect(data.status).toBe("updated");
    expect(data.config.heartbeatIntervalMs).toBe(30000);
    expect(data.config.discoveryEnabled).toBe(false);
    expect(data.config.evolutionEnabled).toBe(true);
    expect(data.config.mutationRate).toBe(0.25);
    expect(data.config.maxConcurrentStrategies).toBe(10);
  });

  // 5. PUT /config/agent validation: heartbeat < 5000 -> 400
  it("PUT /config/agent rejects heartbeatIntervalMs < 5000", async () => {
    const payload = {
      heartbeatIntervalMs: 1000, // below minimum of 5000
      discoveryEnabled: true,
      evolutionEnabled: false,
      mutationRate: 0.1,
      maxConcurrentStrategies: 5,
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toBeDefined();
  });

  // 6. PUT /config/gates updates promotion gates
  it("PUT /config/gates updates promotion gate thresholds", async () => {
    const payload = {
      l0l1: { minDays: 10, minSharpe: 0.8, maxDrawdown: -0.25, minWinRate: 0.45, minTrades: 15 },
      l1l2: { minDays: 20, minSharpe: 1.2, maxDrawdown: -0.18, minWinRate: 0.5, minTrades: 40 },
      l2l3: { minDays: 45, minSharpe: 1.8, maxDrawdown: -0.08, minWinRate: 0.55, minTrades: 60 },
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/gates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(200);
    const data = body as { status: string; gates: Record<string, unknown> };
    expect(data.status).toBe("updated");
    expect(data.gates).toMatchObject(payload);
  });

  // 7. PUT /config/gates validation: maxDrawdown > 0 -> 400
  it("PUT /config/gates rejects maxDrawdown > 0", async () => {
    const payload = {
      l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: 0.2, minWinRate: 0.4, minTrades: 10 }, // positive maxDrawdown — invalid
      l1l2: { minDays: 14, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.45, minTrades: 30 },
      l2l3: { minDays: 30, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.5, minTrades: 50 },
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config/gates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toBeDefined();
  });

  // 8. GET /exchange-health returns health records
  it("GET /exchange-health returns exchange health records", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchange-health`);
    expect(status).toBe(200);

    const data = body as { exchanges: unknown[] };
    expect(data.exchanges).toBeDefined();
    expect(Array.isArray(data.exchanges)).toBe(true);
    // Initially empty since no exchanges are configured in the default harness
    expect(data.exchanges.length).toBe(0);
  });
});
