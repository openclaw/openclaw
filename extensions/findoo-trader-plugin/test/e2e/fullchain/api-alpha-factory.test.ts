/**
 * Phase F — Alpha Factory API full-chain E2E tests.
 * Tests GET /alpha-factory/stats, POST /alpha-factory/trigger,
 * GET /alpha-factory/failures against real services.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000 } }));
    fetchMarkets = vi.fn(async () => []);
    fetchOrderBook = vi.fn(async () => ({ bids: [], asks: [], timestamp: Date.now() }));
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

describe("Phase F — Alpha Factory API", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // 1. GET /alpha-factory/stats returns initial stats (running=true, counters zero)
  it("GET /alpha-factory/stats returns initial stats", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/stats`);
    expect(status).toBe(200);

    const data = body as Record<string, unknown>;
    expect(data.running).toBe(true);
    expect(data.ideationCount).toBe(0);
    expect(data.screeningPassed).toBe(0);
    expect(data.screeningFailed).toBe(0);
    expect(data.validationPassed).toBe(0);
    expect(data.validationFailed).toBe(0);
    expect(data.gcKilled).toBe(0);
    expect(data.evolutionCycles).toBe(0);
    expect(data.lastCycleAt).toBe(0);
  });

  // 2. POST /alpha-factory/trigger with no strategies returns zeros
  it("POST /alpha-factory/trigger with no strategies returns zeros", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/trigger`,
      {
        method: "POST",
      },
    );
    expect(status).toBe(200);

    const data = body as { screened: number; validated: number; failed: number };
    expect(data.screened).toBe(0);
    expect(data.validated).toBe(0);
    expect(data.failed).toBe(0);
  });

  // 3. GET /alpha-factory/failures initially returns empty
  it("GET /alpha-factory/failures initially returns empty", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/failures`,
    );
    expect(status).toBe(200);

    const data = body as { summary: string; recent: unknown[] };
    expect(data.summary).toBe("");
    expect(data.recent).toEqual([]);
  });

  // 4. Create strategy → trigger → returns screened=1, failed=1 (backtest returns null)
  it("trigger with one strategy fails screening (backtest null)", async () => {
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Alpha Test 1",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });

    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/trigger`,
      {
        method: "POST",
      },
    );
    expect(status).toBe(200);

    const data = body as { screened: number; validated: number; failed: number };
    expect(data.screened).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.validated).toBe(0);
  });

  // 5. After trigger, GET /stats shows screeningFailed incremented
  it("stats reflect screeningFailed after trigger", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/stats`);
    expect(status).toBe(200);

    const data = body as Record<string, number>;
    expect(data.screeningFailed).toBeGreaterThanOrEqual(1);
    expect(data.screeningPassed).toBe(0);
  });

  // 6. Create multiple strategies → trigger → screened count matches total
  it("trigger with multiple strategies screens all", async () => {
    // Create a second strategy
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "rsi-mean-revert",
        name: "Alpha Test 2",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { rsiPeriod: 14, oversold: 30, overbought: 70 },
      }),
    });

    const totalStrategies = ctx.services.strategyRegistry.list().length;

    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/trigger`,
      {
        method: "POST",
      },
    );
    expect(status).toBe(200);

    const data = body as { screened: number; validated: number; failed: number };
    expect(data.screened).toBe(totalStrategies);
    expect(data.failed).toBe(totalStrategies); // all fail — backtest returns null
  });

  // 7. Stats show cumulative counts across multiple triggers
  it("stats accumulate across multiple triggers", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/stats`);
    expect(status).toBe(200);

    const data = body as Record<string, number>;
    // Multiple triggers have accumulated screening failures
    expect(data.screeningFailed).toBeGreaterThanOrEqual(2);
  });

  // 8. Record failure patterns → GET /failures shows them
  it("recorded failure patterns appear in GET /failures", async () => {
    ctx.services.failureFeedbackStore.record({
      templateId: "sma-crossover",
      symbol: "BTC/USDT",
      failStage: "screening",
      failReason: "Backtest returned no result",
      parameters: { fastPeriod: 10, slowPeriod: 30 },
      timestamp: Date.now(),
    });

    ctx.services.failureFeedbackStore.record({
      templateId: "rsi-mean-revert",
      symbol: "ETH/USDT",
      failStage: "validation",
      failReason: "Monte Carlo p > 0.05",
      parameters: { rsiPeriod: 14 },
      timestamp: Date.now(),
    });

    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/failures`,
    );
    expect(status).toBe(200);

    const data = body as { summary: string; recent: unknown[] };
    expect(data.recent.length).toBe(2);
  });

  // 9. Failure summary contains expected markdown format
  it("failure summary contains markdown headings and details", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/alpha-factory/failures`,
    );
    expect(status).toBe(200);

    const data = body as { summary: string; recent: unknown[] };
    expect(data.summary).toContain("## Lessons from Recent Failures");
    expect(data.summary).toContain("screening");
    expect(data.summary).toContain("sma-crossover");
    expect(data.summary).toContain("validation");
    expect(data.summary).toContain("rsi-mean-revert");
  });

  // 10. Stats lastCycleAt is updated after trigger
  it("lastCycleAt updates after trigger", async () => {
    const before = Date.now();

    // Create a fresh strategy so trigger processes at least one
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "bollinger-breakout",
        name: "Alpha Test Timestamp",
        symbol: "SOL/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { period: 20, stdDev: 2 },
      }),
    });

    await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/trigger`, {
      method: "POST",
    });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/stats`);
    expect(status).toBe(200);

    const data = body as { lastCycleAt: number };
    expect(data.lastCycleAt).toBeGreaterThanOrEqual(before);
  });
});
