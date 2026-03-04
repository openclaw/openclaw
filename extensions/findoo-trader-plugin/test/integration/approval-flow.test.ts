/**
 * Integration tests for the approval flow (events/approve endpoint).
 * Tests pending event listing, approve, and reject actions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HttpRes } from "../../src/types-http.js";

// ── Mock helpers ──

/** Create a mock HTTP request with a JSON body. */
function mockReq(body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  const buf = Buffer.from(json, "utf-8");
  return {
    on(event: string, cb: (data?: Buffer) => void) {
      if (event === "data") cb(buf);
      if (event === "end") cb();
    },
    method: "POST",
  };
}

/** Create a mock HTTP response that captures status and body. */
function mockRes() {
  let status = 0;
  let body = "";
  const res: HttpRes & { getStatus: () => number; getJson: () => unknown } = {
    writeHead(s: number, _h: Record<string, string>) {
      status = s;
    },
    write(chunk: string) {
      body += chunk;
      return true;
    },
    end(b?: string) {
      if (b) body += b;
    },
    getStatus: () => status,
    getJson: () => JSON.parse(body),
  };
  return res;
}

/** In-memory event store that simulates AgentEventSqliteStore behavior. */
function makeInMemoryEventStore() {
  let counter = 0;
  const events: Array<{
    id: string;
    type: string;
    title: string;
    detail: string;
    status: string;
    timestamp: number;
    actionParams?: Record<string, unknown>;
  }> = [];

  return {
    addEvent(input: {
      type: string;
      title: string;
      detail: string;
      status: string;
      actionParams?: Record<string, unknown>;
    }) {
      const event = {
        ...input,
        id: `evt-${++counter}-test`,
        timestamp: Date.now(),
      };
      events.push(event);
      return event;
    },
    listEvents(filter?: { type?: string; status?: string }) {
      let result = [...events];
      if (filter?.type) result = result.filter((e) => e.type === filter.type);
      if (filter?.status) result = result.filter((e) => e.status === filter.status);
      return result.reverse();
    },
    getEvent(id: string) {
      return events.find((e) => e.id === id);
    },
    approve(id: string) {
      const event = events.find((e) => e.id === id);
      if (!event || event.status !== "pending") return undefined;
      event.status = "approved";
      return event;
    },
    reject(id: string, reason?: string) {
      const event = events.find((e) => e.id === id);
      if (!event || event.status !== "pending") return undefined;
      event.status = "rejected";
      return event;
    },
    pendingCount() {
      return events.filter((e) => e.status === "pending").length;
    },
    subscribe: vi.fn(() => () => {}),
  };
}

// Build a mock `api` that captures route registrations.
function captureRoutes() {
  const routes = new Map<string, (req: unknown, res: HttpRes) => Promise<void>>();
  const api = {
    registerHttpRoute: vi.fn(
      ({
        path,
        handler,
      }: {
        path: string;
        handler: (req: unknown, res: HttpRes) => Promise<void>;
      }) => {
        routes.set(path, handler);
      },
    ),
  };
  return { api, routes };
}

// Mock ccxt
vi.mock("ccxt", () => ({ binance: class {} }));

describe("approval-flow integration", () => {
  let routes: Map<string, (req: unknown, res: HttpRes) => Promise<void>>;
  let eventStore: ReturnType<typeof makeInMemoryEventStore>;

  beforeEach(async () => {
    eventStore = makeInMemoryEventStore();

    const captured = captureRoutes();

    // Import the main route handler registration which includes the approval route
    const { registerHttpRoutes } = await import("../../src/core/route-handlers.js");
    const { ExchangeRegistry } = await import("../../src/core/exchange-registry.js");
    const { RiskController } = await import("../../src/core/risk-controller.js");

    const registry = new ExchangeRegistry();
    const riskController = new RiskController({
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 1000,
      maxDailyLossUsd: 5000,
      maxPositionPct: 20,
      maxLeverage: 10,
    });

    registerHttpRoutes({
      api: captured.api as unknown as Parameters<typeof registerHttpRoutes>[0]["api"],
      gatherDeps: {
        registry,
        riskConfig: riskController["config" as keyof typeof riskController] as Parameters<
          typeof registerHttpRoutes
        >[0]["gatherDeps"]["riskConfig"],
        eventStore: eventStore as unknown as Parameters<
          typeof registerHttpRoutes
        >[0]["gatherDeps"]["eventStore"],
        runtime: { services: new Map() },
        pluginEntries: {},
      },
      eventStore: eventStore as unknown as Parameters<typeof registerHttpRoutes>[0]["eventStore"],
      healthStore: {
        upsert: vi.fn(),
        listAll: vi.fn(() => []),
        get: vi.fn(),
        recordPing: vi.fn(),
        recordError: vi.fn(),
      } as unknown as Parameters<typeof registerHttpRoutes>[0]["healthStore"],
      riskController,
      runtime: { services: new Map() },
      templates: {
        overview: "",
        tradingDesk: "",
        strategyLab: "",
      } as unknown as Parameters<typeof registerHttpRoutes>[0]["templates"],
      registry,
    });

    routes = captured.routes;
  });

  // ── GET /api/v1/finance/events — List events ──

  it("should list all events including pending ones", async () => {
    // Seed some events
    eventStore.addEvent({
      type: "trade_pending",
      title: "BUY 0.1 BTC/USDT",
      detail: "Requires confirmation",
      status: "pending",
      actionParams: { symbol: "BTC/USDT", side: "buy", quantity: 0.1 },
    });
    eventStore.addEvent({
      type: "system",
      title: "Config updated",
      detail: "Risk config changed",
      status: "completed",
    });

    const handler = routes.get("/api/v1/finance/events")!;
    expect(handler).toBeDefined();

    const res = mockRes();
    await handler({}, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { events: unknown[]; pendingCount: number };
    expect(json.events).toHaveLength(2);
    expect(json.pendingCount).toBe(1);
  });

  // ── POST /api/v1/finance/events/approve — Approve action ──

  it("should approve a pending event", async () => {
    const pending = eventStore.addEvent({
      type: "trade_pending",
      title: "BUY 0.5 ETH/USDT",
      detail: "Trade value $500 exceeds auto-trade limit",
      status: "pending",
    });

    const handler = routes.get("/api/v1/finance/events/approve")!;
    expect(handler).toBeDefined();

    const req = mockReq({ id: pending.id, action: "approve" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; event: { id: string; status: string } };
    expect(json.status).toBe("approved");
    expect(json.event.status).toBe("approved");

    // Verify the event store was updated
    const updated = eventStore.getEvent(pending.id);
    expect(updated!.status).toBe("approved");
  });

  // ── POST /api/v1/finance/events/approve — Reject action ──

  it("should reject a pending event with reason", async () => {
    const pending = eventStore.addEvent({
      type: "trade_pending",
      title: "BUY 1.0 SHIB/USDT",
      detail: "Risky trade",
      status: "pending",
    });

    const handler = routes.get("/api/v1/finance/events/approve")!;
    const req = mockReq({
      id: pending.id,
      action: "reject",
      reason: "Too risky, avoid meme coins",
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string };
    expect(json.status).toBe("rejected");

    // Verify the event was rejected
    const updated = eventStore.getEvent(pending.id);
    expect(updated!.status).toBe("rejected");
  });

  it("should return 404 when approving non-existent event", async () => {
    const handler = routes.get("/api/v1/finance/events/approve")!;
    const req = mockReq({ id: "evt-nonexistent", action: "approve" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(404);
  });

  it("should return 400 when id is missing", async () => {
    const handler = routes.get("/api/v1/finance/events/approve")!;
    const req = mockReq({ action: "approve" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(400);
  });

  it("should not allow approving an already-completed event", async () => {
    const completed = eventStore.addEvent({
      type: "system",
      title: "Done",
      detail: "Already completed",
      status: "completed",
    });

    const handler = routes.get("/api/v1/finance/events/approve")!;
    const req = mockReq({ id: completed.id, action: "approve" });
    const res = mockRes();
    await handler(req, res);

    // approve() returns undefined for non-pending events → 404
    expect(res.getStatus()).toBe(404);
  });
});
