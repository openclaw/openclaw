/**
 * Phase F — B7: Dashboard JSON API full-chain E2E tests.
 * Validates all /api/v1/finance/* JSON endpoints including dashboard tabs,
 * trading, command center, mission control, AI chat, daily brief, and risk evaluation.
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

describe("B7 — Dashboard JSON API full-chain", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  it("dashboard/strategy returns pipeline data with pipeline object", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/strategy`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("pipeline");
    const pipeline = data.pipeline as Record<string, number>;
    expect(pipeline).toHaveProperty("l0");
    expect(pipeline).toHaveProperty("l1");
    expect(pipeline).toHaveProperty("l2");
    expect(pipeline).toHaveProperty("l3");
    expect(pipeline).toHaveProperty("total");
    expect(data).toHaveProperty("strategies");
    expect(data).toHaveProperty("backtests");
    expect(data).toHaveProperty("allocations");
    expect(data).toHaveProperty("gates");
    expect(data).toHaveProperty("decayData");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("risk");
  });

  it("dashboard/trader?domain=paper returns paper trading data", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/dashboard/trader?domain=paper`,
    );
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data.domain).toBe("paper");
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("risk");
  });

  it("dashboard/trader?domain=backtest returns backtest data", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/dashboard/trader?domain=backtest`,
    );
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data.domain).toBe("backtest");
    expect(data).toHaveProperty("backtestResults");
    expect(Array.isArray(data.backtestResults)).toBe(true);
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("risk");
  });

  it("dashboard/trader?domain=live returns live data", async () => {
    const { status, body } = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/dashboard/trader?domain=live`,
    );
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data.domain).toBe("live");
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("alerts");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("risk");
  });

  it("dashboard/setting returns setting data with all sections", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/setting`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("exchanges");
    expect(data).toHaveProperty("exchangeHealth");
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("agent");
    expect(data).toHaveProperty("gates");
    expect(data).toHaveProperty("notifications");
    expect(data).toHaveProperty("onboarding");
    expect(data).toHaveProperty("plugins");
  });

  it("/finance/trading returns complete trading data", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/trading`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("positions");
    expect(data).toHaveProperty("orders");
    expect(data).toHaveProperty("snapshots");
    expect(data).toHaveProperty("strategies");
    expect(data).toHaveProperty("backtests");
    expect(data).toHaveProperty("allocations");
  });

  it("/finance/command-center returns CC data", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/command-center`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("alerts");
    expect(data).toHaveProperty("risk");
  });

  it("/finance/mission-control returns MC data", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/mission-control`);
    expect(status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data).toHaveProperty("trading");
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("alerts");
    expect(data).toHaveProperty("risk");
    expect(data).toHaveProperty("fund");
  });

  it("/finance/ai/chat returns response (POST with message)", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(status).toBe(200);
    const data = body as { reply: string; role: string; fallback?: boolean };
    expect(data.role).toBe("assistant");
    expect(typeof data.reply).toBe("string");
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("/finance/ai/chat missing message returns 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toContain("Missing message");
  });

  it("/finance/daily-brief returns brief object", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/daily-brief`);
    expect(status).toBe(200);
    const data = body as { brief: Record<string, unknown> };
    expect(data).toHaveProperty("brief");
    expect(data.brief).toHaveProperty("date");
    expect(data.brief).toHaveProperty("marketSummary");
    expect(data.brief).toHaveProperty("portfolioChange");
    expect(data.brief).toHaveProperty("recommendation");
  });

  it("/finance/risk/evaluate returns risk tier", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/risk/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 1,
        estimatedValueUsd: 50,
      }),
    });
    expect(status).toBe(200);
    const data = body as { tier: string; reason?: string };
    expect(data).toHaveProperty("tier");
    expect(["auto", "confirm", "reject"]).toContain(data.tier);
  });
});
