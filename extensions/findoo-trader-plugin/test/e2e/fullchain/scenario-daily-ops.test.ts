/**
 * Phase F — Scenario: Daily Operations
 *
 * Tests daily monitoring operations including brief generation, alert management,
 * SSE push on state changes, and complete dashboard data aggregation.
 * All 5 tests share state and run sequentially.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-daily-ops.test.ts
 */

import http from "node:http";
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

/**
 * Collect SSE `data:` payloads from an event-stream URL.
 * Resolves when `count` events are collected or `timeoutMs` expires.
 */
function collectSseEvents(url: string, count: number, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const parsed = new URL(url);
    const req = http.get(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/^data: (.+)$/);
            if (match) {
              events.push(match[1]!);
              if (events.length >= count) {
                req.destroy();
                resolve(events);
                return;
              }
            }
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", (err) => {
      // ECONNRESET from req.destroy() is expected
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(err);
      }
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("Phase F — Scenario: Daily Operations", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
    // Create a paper account for order and dashboard testing
    ctx.services.paperEngine.createAccount("daily-ops-account", 50_000);
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Morning brief generation via HTTP ──
  it("GET /daily-brief returns a well-formed brief with today's date", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/daily-brief`);

    expect(status).toBe(200);
    const data = body as {
      brief: {
        date: string;
        marketSummary: string;
        portfolioChange: { totalEquity: number; dailyPnl: number; dailyPnlPct: number };
        recommendation: string;
      };
    };
    expect(data.brief).toBeDefined();
    expect(typeof data.brief.date).toBe("string");
    expect(typeof data.brief.marketSummary).toBe("string");
    expect(data.brief.portfolioChange).toBeDefined();
    expect(typeof data.brief.portfolioChange.totalEquity).toBe("number");
    expect(typeof data.brief.portfolioChange.dailyPnl).toBe("number");
    expect(typeof data.brief.portfolioChange.dailyPnlPct).toBe("number");
    expect(typeof data.brief.recommendation).toBe("string");

    // Verify brief.date matches today's date (YYYY-MM-DD)
    const today = new Date().toISOString().split("T")[0]!;
    expect(data.brief.date).toBe(today);
  });

  // ── 2. Brief writes to event store ──
  it("daily brief generation records a system event in the event store", () => {
    // After the brief was generated in test 1, check event store directly
    const events = ctx.services.eventStore.listEvents();
    const briefEvent = events.find((e) => e.type === "system" && e.title === "Daily Brief");
    expect(briefEvent).toBeDefined();
    expect(briefEvent!.status).toBe("completed");
    expect(briefEvent!.detail).toContain("Equity:");
    expect(briefEvent!.detail).toContain("Strategies:");
  });

  // ── 3. Alert lifecycle: create -> list -> remove -> verify ──
  it("alert lifecycle: create 2 alerts, list, remove one, verify remaining", async () => {
    // Create a price_above alert
    const alertA = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "price_above",
        symbol: "BTC/USDT",
        price: 70000,
        message: "BTC broke 70k!",
      }),
    });
    expect(alertA.status).toBe(201);
    const alertIdA = (alertA.body as { id: string }).id;
    expect(alertIdA).toBeTruthy();

    // Create a drawdown alert
    const alertB = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "drawdown",
        threshold: -0.1,
        direction: "below",
        message: "Portfolio drawdown exceeded 10%",
      }),
    });
    expect(alertB.status).toBe(201);
    const alertIdB = (alertB.body as { id: string }).id;
    expect(alertIdB).toBeTruthy();

    // GET /alerts should return 2
    const listRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(listRes.status).toBe(200);
    const listData = listRes.body as { alerts: Array<{ id: string }> };
    expect(listData.alerts.length).toBe(2);

    // Remove first alert
    const removeRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: alertIdA }),
    });
    expect(removeRes.status).toBe(200);
    const removeData = removeRes.body as { status: string; id: string };
    expect(removeData.status).toBe("removed");
    expect(removeData.id).toBe(alertIdA);

    // GET /alerts should return 1 remaining
    const afterRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alerts`);
    expect(afterRes.status).toBe(200);
    const afterData = afterRes.body as { alerts: Array<{ id: string }> };
    expect(afterData.alerts.length).toBe(1);
    expect(afterData.alerts[0]!.id).toBe(alertIdB);
  });

  // ── 4. SSE pushes real-time changes ──
  it("SSE events/stream pushes new_event when eventStore receives an event", async () => {
    // Start listening for SSE events (expect at least 2: initial snapshot + pushed event)
    const ssePromise = collectSseEvents(`${ctx.baseUrl}/api/v1/finance/events/stream`, 2, 4000);

    // Give the SSE connection time to establish and subscribe
    await new Promise((r) => setTimeout(r, 300));

    // Inject a test event through the event store
    ctx.services.eventStore.addEvent({
      type: "system",
      title: "SSE Push Test",
      detail: "Daily ops SSE push verification",
      status: "completed",
    });

    const events = await ssePromise;
    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event is the initial snapshot with events array
    const initial = JSON.parse(events[0]!) as Record<string, unknown>;
    expect(initial).toHaveProperty("events");
    expect(initial).toHaveProperty("pendingCount");
    expect(typeof initial.pendingCount).toBe("number");

    // Second event should be the pushed new_event notification
    const pushed = JSON.parse(events[1]!) as Record<string, unknown>;
    expect(pushed.type).toBe("new_event");
    expect(pushed).toHaveProperty("event");
    expect(pushed).toHaveProperty("pendingCount");

    const pushedEvent = pushed.event as Record<string, unknown>;
    expect(pushedEvent.title).toBe("SSE Push Test");
    expect(pushedEvent.detail).toBe("Daily ops SSE push verification");
  });

  // ── 5. Complete daily monitoring dashboard data ──
  it("dashboard endpoints return complete monitoring data", async () => {
    // First, create some strategies and orders to populate dashboard data
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Dashboard Check Strategy",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);

    // Place a small order to add trading activity
    const orderRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 0.1,
        currentPrice: 50,
        reason: "dashboard data test",
      }),
    });
    expect(orderRes.status).toBe(201);

    // GET /dashboard/strategy
    const strategyDash = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/strategy`);
    expect(strategyDash.status).toBe(200);
    const strategyData = strategyDash.body as Record<string, unknown>;
    expect(strategyData).toHaveProperty("pipeline");
    expect(strategyData).toHaveProperty("strategies");
    expect(strategyData).toHaveProperty("events");
    const pipeline = strategyData.pipeline as Record<string, number>;
    expect(typeof pipeline.total).toBe("number");
    expect(pipeline.total).toBeGreaterThanOrEqual(1);

    // GET /dashboard/trader?domain=paper
    const traderDash = await fetchJson(
      `${ctx.baseUrl}/api/v1/finance/dashboard/trader?domain=paper`,
    );
    expect(traderDash.status).toBe(200);
    const traderData = traderDash.body as Record<string, unknown>;
    expect(traderData.domain).toBe("paper");
    expect(traderData).toHaveProperty("trading");
    expect(traderData).toHaveProperty("events");
    expect(traderData).toHaveProperty("risk");

    // GET /mission-control
    const mcDash = await fetchJson(`${ctx.baseUrl}/api/v1/finance/mission-control`);
    expect(mcDash.status).toBe(200);
    const mcData = mcDash.body as Record<string, unknown>;
    expect(mcData).toHaveProperty("trading");
    expect(mcData).toHaveProperty("events");
    expect(mcData).toHaveProperty("alerts");
    expect(mcData).toHaveProperty("risk");
    expect(mcData).toHaveProperty("fund");

    // Verify all responses have meaningful content (not empty)
    const mcEvents = (mcData.events as { events?: unknown[] })?.events;
    expect(Array.isArray(mcEvents)).toBe(true);
    expect(mcEvents!.length).toBeGreaterThan(0);
  });
});
