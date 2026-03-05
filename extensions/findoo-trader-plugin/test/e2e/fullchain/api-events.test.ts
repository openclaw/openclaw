/**
 * Phase F — Full-chain E2E: Events & Approval API (B5)
 *
 * Tests the agent event lifecycle through real HTTP routes backed by real
 * SQLite-persisted AgentEventSqliteStore: list, approve, reject, L3 promotion
 * side-effect, pending count tracking, and persistence.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/api-events.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentEventSqliteStore } from "../../../src/core/agent-event-sqlite-store.js";
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

describe("B5 — Events & Approval API full-chain", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
    // Create a paper account so the order route can find one
    ctx.services.paperEngine.createAccount("test", 10000);
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ── 1. GET /events initially empty ──
  it("GET /events returns empty list initially", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    expect(status).toBe(200);
    const data = body as { events: unknown[]; pendingCount: number };
    expect(data.events).toEqual([]);
    expect(data.pendingCount).toBe(0);
  });

  // ── 2. Place order that creates a pending event ──
  it("POST /orders with confirm-tier amount creates a pending event", async () => {
    // Risk config: maxAutoTradeUsd=100, confirmThresholdUsd=1000
    // currentPrice=200 * quantity=3 = $600 → confirm tier → pending event
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 3,
        currentPrice: 200,
      }),
    });

    expect(status).toBe(202);
    const data = body as { status: string; eventId: string; reason: string };
    expect(data.status).toBe("pending_approval");
    expect(data.eventId).toBeTruthy();
  });

  // ── 3. Approve pending trade event → 200 ──
  it("POST /events/approve approves a pending event", async () => {
    // Fetch events to get the pending event id
    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    const events = (eventsRes.body as { events: Array<{ id: string; status: string }> }).events;
    const pendingEvent = events.find((e) => e.status === "pending");
    expect(pendingEvent).toBeDefined();

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pendingEvent!.id }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; event: { id: string; status: string } };
    expect(data.status).toBe("approved");
    expect(data.event.status).toBe("approved");
  });

  // ── 4. Reject with reason → 200 ──
  it("POST /events/approve with action=reject rejects an event with reason", async () => {
    // Create another pending event via a confirm-tier order
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "ETH/USDT",
        side: "buy",
        type: "market",
        quantity: 2,
        currentPrice: 300,
      }),
    });

    // Fetch events to find the new pending event
    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    const events = (eventsRes.body as { events: Array<{ id: string; status: string }> }).events;
    const pendingEvent = events.find((e) => e.status === "pending");
    expect(pendingEvent).toBeDefined();

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: pendingEvent!.id,
        action: "reject",
        reason: "Too risky right now",
      }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; event: { id: string; status: string } };
    expect(data.status).toBe("rejected");
    expect(data.event.status).toBe("rejected");
  });

  // ── 5. Invalid id → 404 ──
  it("POST /events/approve with invalid id returns 404", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nonexistent-event-id-999" }),
    });

    expect(status).toBe(404);
    const data = body as { error: string };
    expect(data.error).toBeTruthy();
  });

  // ── 6. Missing id → 400 ──
  it("POST /events/approve with missing id returns 400", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });

    expect(status).toBe(400);
    const data = body as { error: string };
    expect(data.error).toContain("id");
  });

  // ── 7. Approve L3 promotion updates strategy level ──
  it("approving L3 promotion event promotes strategy to L3_LIVE", async () => {
    // Create a strategy
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "L3 Promotion Test",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const sid = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Promote L0→L1
    const p1 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });
    expect(p1.status).toBe(200);

    // Promote L1→L2
    const p2 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });
    expect(p2.status).toBe(200);

    // Promote L2→L3 → 202 pending approval
    const p3 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });
    expect(p3.status).toBe(202);

    // Find the pending promote_l3 event
    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    const events = (
      eventsRes.body as {
        events: Array<{
          id: string;
          status: string;
          actionParams?: { action?: string; strategyId?: string };
        }>;
      }
    ).events;
    const promoteEvent = events.find(
      (e) =>
        e.status === "pending" &&
        e.actionParams?.action === "promote_l3" &&
        e.actionParams?.strategyId === sid,
    );
    expect(promoteEvent).toBeDefined();

    // Approve the L3 promotion event
    const approveRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: promoteEvent!.id }),
    });
    expect(approveRes.status).toBe(200);

    // Verify strategy is now L3_LIVE
    const strategiesRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    const strategies = (strategiesRes.body as { strategies: Array<{ id: string; level: string }> })
      .strategies;
    const promoted = strategies.find((s) => s.id === sid);
    expect(promoted).toBeDefined();
    expect(promoted!.level).toBe("L3_LIVE");
  });

  // ── 8. Reject L3 promotion keeps L2 ──
  it("rejecting L3 promotion event keeps strategy at L2_PAPER", async () => {
    // Create another strategy
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "rsi-mean-reversion",
        name: "L3 Reject Test",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { rsiPeriod: 14, oversold: 30, overbought: 70 },
      }),
    });
    expect(createRes.status).toBe(201);
    const sid = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Promote L0→L1→L2
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });

    // Promote L2→L3 → 202
    const p3 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sid }),
    });
    expect(p3.status).toBe(202);

    // Find the pending promote_l3 event
    const eventsRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    const events = (
      eventsRes.body as {
        events: Array<{
          id: string;
          status: string;
          actionParams?: { action?: string; strategyId?: string };
        }>;
      }
    ).events;
    const promoteEvent = events.find(
      (e) =>
        e.status === "pending" &&
        e.actionParams?.action === "promote_l3" &&
        e.actionParams?.strategyId === sid,
    );
    expect(promoteEvent).toBeDefined();

    // Reject the L3 promotion
    const rejectRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: promoteEvent!.id,
        action: "reject",
        reason: "Not ready for live trading",
      }),
    });
    expect(rejectRes.status).toBe(200);

    // Verify strategy stays at L2_PAPER
    const strategiesRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    const strategies = (strategiesRes.body as { strategies: Array<{ id: string; level: string }> })
      .strategies;
    const rejected = strategies.find((s) => s.id === sid);
    expect(rejected).toBeDefined();
    expect(rejected!.level).toBe("L2_PAPER");
  });

  // ── 9. pendingCount reflects current pending events ──
  it("pendingCount reflects the actual number of pending events", async () => {
    // Create two new pending events via confirm-tier orders
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "SOL/USDT",
        side: "buy",
        type: "market",
        quantity: 2,
        currentPrice: 150,
      }),
    });
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "DOGE/USDT",
        side: "sell",
        type: "market",
        quantity: 5,
        currentPrice: 100,
      }),
    });

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/events`);
    expect(status).toBe(200);
    const data = body as { events: unknown[]; pendingCount: number };

    // Count pending events manually to verify consistency
    const allEvents = data.events as Array<{ status: string }>;
    const actualPending = allEvents.filter((e) => e.status === "pending").length;
    expect(data.pendingCount).toBe(actualPending);
    // We have at least the 2 new pending events (plus possibly others from earlier tests)
    expect(data.pendingCount).toBeGreaterThanOrEqual(2);
  });

  // ── 10. SQLite persistence: events survive re-read ──
  it("events persist to SQLite and survive re-read from same database", () => {
    const dbPath = `${ctx.tmpDir}/events.sqlite`;
    // Create a fresh store pointing at the same SQLite file
    const freshStore = new AgentEventSqliteStore(dbPath);
    const events = freshStore.listEvents();

    // We should have multiple events from all the tests above
    expect(events.length).toBeGreaterThan(0);

    // Verify pending count is consistent
    const pendingCount = freshStore.pendingCount();
    const actualPending = events.filter((e) => e.status === "pending").length;
    expect(pendingCount).toBe(actualPending);

    freshStore.close();
  });
});
