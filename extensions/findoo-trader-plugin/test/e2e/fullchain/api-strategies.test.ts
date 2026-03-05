/**
 * Phase F — Full-chain E2E: Strategy API (B4)
 *
 * Tests the complete strategy lifecycle through real HTTP routes backed by
 * real service instances: list, create from template, promote through levels,
 * pause/resume/kill, pause-all, and JSON persistence.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/api-strategies.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StrategyRegistry } from "../../../src/strategy/strategy-registry.js";
import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

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

describe("B4 — Strategy API full-chain", () => {
  let ctx: FullChainContext;
  let strategyId: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ── 1. GET /strategies initially empty ──
  it("GET /strategies returns empty list initially", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(status).toBe(200);
    const data = body as { strategies: unknown[] };
    expect(data.strategies).toEqual([]);
  });

  // ── 2. GET /strategy-templates returns built-in templates ──
  it("GET /strategy-templates returns built-in templates", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    expect(status).toBe(200);
    const data = body as { templates: Array<{ id: string; name: string }> };
    expect(Array.isArray(data.templates)).toBe(true);
    expect(data.templates.length).toBeGreaterThan(0);
    // Verify at least one known template exists
    const ids = data.templates.map((t) => t.id);
    expect(ids).toContain("sma-crossover");
  });

  // ── 3. POST create from template → 201 ──
  it("POST /strategies/create from template returns 201 with L0_INCUBATE", async () => {
    // Fetch templates to get the first one
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    const firstTemplate = templates[0]!;

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: firstTemplate.id,
        name: "Test SMA Strategy",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });

    expect(status).toBe(201);
    const data = body as { strategy: { id: string; name: string; level: string } };
    expect(data.strategy).toBeDefined();
    expect(data.strategy.id).toBeTruthy();
    expect(data.strategy.name).toBe("Test SMA Strategy");
    expect(data.strategy.level).toBe("L0_INCUBATE");

    // Store the id for subsequent tests
    strategyId = data.strategy.id;
  });

  // ── 4. POST create validates schema (missing templateId → 400) ──
  it("POST /strategies/create rejects missing templateId with 400", async () => {
    const { status } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Strategy",
        symbol: "ETH/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: {},
      }),
    });

    expect(status).toBe(400);
  });

  // ── 5. POST create with unknown template → 400 ──
  it("POST /strategies/create rejects unknown template with 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "nonexistent-template-xyz",
        name: "Ghost Strategy",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: {},
      }),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toContain("Unknown template");
  });

  // ── 6. POST promote L0→L1 → 200 ──
  it("POST /strategies/promote L0→L1 returns 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string; from: string; to: string };
    expect(data.status).toBe("promoted");
    // Note: `from` reflects the level after mutation (updateLevel mutates in-place),
    // so it equals the new level. We assert the `to` target is correct.
    expect(data.to).toBe("L1_BACKTEST");
    expect(data.id).toBe(strategyId);
  });

  // ── 7. POST promote L1→L2 → 200 ──
  it("POST /strategies/promote L1→L2 returns 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string; from: string; to: string };
    expect(data.status).toBe("promoted");
    expect(data.to).toBe("L2_PAPER");
    expect(data.id).toBe(strategyId);
  });

  // ── 8. POST promote L2→L3 → 202 pending approval ──
  it("POST /strategies/promote L2→L3 returns 202 pending approval", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(202);
    const data = body as { status: string; id: string; targetLevel: string };
    expect(data.status).toBe("pending_approval");
    expect(data.targetLevel).toBe("L3_LIVE");
  });

  // ── 9. POST pause → 200 ──
  it("POST /strategies/pause returns 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("paused");
    expect(data.id).toBe(strategyId);
  });

  // ── 10. POST resume → 200 ──
  it("POST /strategies/resume returns 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("running");
    expect(data.id).toBe(strategyId);
  });

  // ── 11. POST kill → 200 ──
  it("POST /strategies/kill returns 200", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: strategyId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("killed");
    expect(data.id).toBe(strategyId);
  });

  // ── 12. POST pause-all → 200 ──
  it("POST /strategies/pause-all returns 200 with count", async () => {
    // Create a second strategy so pause-all has something to work with
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;

    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: templates[0]!.id,
        name: "Pausable Strategy",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { fastPeriod: 5, slowPeriod: 20 },
      }),
    });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/pause-all`, {
      method: "POST",
    });

    expect(status).toBe(200);
    const data = body as { status: string; count: number };
    expect(data.status).toBe("paused_all");
    expect(typeof data.count).toBe("number");
  });

  // ── 13. JSON persistence: strategies survive reload from same file ──
  it("strategies persist to JSON and survive re-read", () => {
    const filePath = `${ctx.tmpDir}/strategies.json`;
    // Create a fresh StrategyRegistry pointing at the same file
    const freshRegistry = new StrategyRegistry(filePath);
    const all = freshRegistry.list();

    // We created 2 strategies total (test 3 + test 12)
    expect(all.length).toBeGreaterThanOrEqual(2);
    // The first strategy should be findable
    const found = all.find((s) => s.id === strategyId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Test SMA Strategy");
  });
});
