/**
 * Phase F — B2: Alerts API full-chain E2E tests.
 * Tests GET /alerts, POST /alerts/create, POST /alerts/remove
 * against real AlertEngine backed by SQLite.
 */
import { join } from "node:path";
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

import { AlertEngine } from "../../../src/core/alert-engine.js";
import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

describe("Phase F — Alerts API (B2)", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15000);

  afterAll(() => ctx.cleanup());

  // 1. GET /alerts initially empty
  it("GET /alerts returns empty list initially", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(status).toBe(200);

    const data = body as { alerts: unknown[] };
    expect(data.alerts).toBeDefined();
    expect(Array.isArray(data.alerts)).toBe(true);
    expect(data.alerts.length).toBe(0);
  });

  // 2. POST create price_above -> 201
  it("POST /alerts/create price_above alert returns 201", async () => {
    const payload = {
      kind: "price_above",
      symbol: "BTC/USDT",
      price: 70000,
      message: "BTC broke 70k!",
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(201);
    const data = body as { id: string; condition: Record<string, unknown>; message: string };
    expect(data.id).toBeDefined();
    expect(typeof data.id).toBe("string");
    expect(data.condition.kind).toBe("price_above");
    expect(data.condition.symbol).toBe("BTC/USDT");
    expect(data.condition.price).toBe(70000);
    expect(data.message).toBe("BTC broke 70k!");
  });

  // 3. POST create volume_spike -> 201
  it("POST /alerts/create volume_spike alert returns 201", async () => {
    const payload = {
      kind: "volume_spike",
      symbol: "ETH/USDT",
      threshold: 3.0,
      message: "ETH volume spike detected",
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(201);
    const data = body as { id: string; condition: Record<string, unknown> };
    expect(data.id).toBeDefined();
    expect(data.condition.kind).toBe("volume_spike");
    expect(data.condition.symbol).toBe("ETH/USDT");
    expect(data.condition.threshold).toBe(3.0);
  });

  // 4. POST create drawdown -> 201
  it("POST /alerts/create drawdown alert returns 201", async () => {
    const payload = {
      kind: "drawdown",
      threshold: -0.1,
      direction: "below",
      message: "Portfolio drawdown exceeded 10%",
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(201);
    const data = body as { id: string; condition: Record<string, unknown> };
    expect(data.id).toBeDefined();
    expect(data.condition.kind).toBe("drawdown");
    expect(data.condition.threshold).toBe(-0.1);
    expect(data.condition.direction).toBe("below");
  });

  // 5. GET /alerts returns all created alerts
  it("GET /alerts returns all previously created alerts", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(status).toBe(200);

    const data = body as { alerts: Array<{ id: string; condition: Record<string, unknown> }> };
    expect(data.alerts.length).toBe(3);

    const kinds = data.alerts.map((a) => a.condition.kind);
    expect(kinds).toContain("price_above");
    expect(kinds).toContain("volume_spike");
    expect(kinds).toContain("drawdown");
  });

  // 6. POST remove -> 200
  it("POST /alerts/remove removes an existing alert", async () => {
    // First get the list to find an id
    const listRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    const alerts = (listRes.body as { alerts: Array<{ id: string }> }).alerts;
    expect(alerts.length).toBeGreaterThan(0);

    const targetId = alerts[0]!.id;
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("removed");
    expect(data.id).toBe(targetId);

    // Verify removal
    const afterRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    const afterAlerts = (afterRes.body as { alerts: Array<{ id: string }> }).alerts;
    expect(afterAlerts.find((a) => a.id === targetId)).toBeUndefined();
  });

  // 7. POST remove invalid id -> 404
  it("POST /alerts/remove returns 404 for non-existent id", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "non-existent-id-00000" }),
    });

    expect(status).toBe(404);
    const data = body as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  // 8. POST create without kind -> 400
  it("POST /alerts/create without kind returns 400", async () => {
    const payload = {
      symbol: "BTC/USDT",
      price: 60000,
    };

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toMatch(/kind/i);
  });

  // 9. 50x rapid create+remove concurrency stress
  it("handles 50x rapid create+remove concurrency without errors", async () => {
    const createPromises = Array.from({ length: 50 }, (_, i) =>
      fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "price_above",
          symbol: `STRESS${i}/USDT`,
          price: 10000 + i,
          message: `stress test alert ${i}`,
        }),
      }),
    );

    const createResults = await Promise.all(createPromises);
    const createdIds: string[] = [];
    for (const r of createResults) {
      expect(r.status).toBe(201);
      createdIds.push((r.body as { id: string }).id);
    }
    expect(createdIds.length).toBe(50);

    // Now remove all 50 in parallel
    const removePromises = createdIds.map((id) =>
      fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    );

    const removeResults = await Promise.all(removePromises);
    for (const r of removeResults) {
      expect(r.status).toBe(200);
      expect((r.body as { status: string }).status).toBe("removed");
    }
  });

  // 10. SQLite persistence: create alert, open new AlertEngine from same db, verify
  it("persists alerts across AlertEngine instances (SQLite durability)", async () => {
    // Create an alert via the API
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "price_below",
        symbol: "SOL/USDT",
        price: 100,
        message: "SOL dipped below 100",
      }),
    });
    expect(createRes.status).toBe(201);
    const createdId = (createRes.body as { id: string }).id;

    // Open a separate AlertEngine instance pointing to the same SQLite file
    const secondEngine = new AlertEngine(join(ctx.tmpDir, "alerts.sqlite"));
    try {
      const alerts = secondEngine.listAlerts();
      const found = alerts.find((a) => a.id === createdId);
      expect(found).toBeDefined();
      expect(found!.condition.kind).toBe("price_below");
      expect(found!.condition.symbol).toBe("SOL/USDT");
      expect(found!.message).toBe("SOL dipped below 100");
    } finally {
      secondEngine.close();
    }
  });
});
