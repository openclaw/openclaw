vi.mock("ccxt", () => ({}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HttpRes } from "../../src/types-http.js";

// ── Mock helpers ──

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
  const subscribers: Array<(event: unknown) => void> = [];

  return {
    addEvent(input: {
      type: string;
      title: string;
      detail: string;
      status: string;
      actionParams?: Record<string, unknown>;
    }) {
      const event = { ...input, id: `evt-${++counter}-test`, timestamp: Date.now() };
      events.push(event);
      for (const sub of subscribers) {
        try {
          sub(event);
        } catch {
          /* ignore */
        }
      }
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
    reject(id: string, _reason?: string) {
      const event = events.find((e) => e.id === id);
      if (!event || event.status !== "pending") return undefined;
      event.status = "rejected";
      return event;
    },
    pendingCount() {
      return events.filter((e) => e.status === "pending").length;
    },
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }),
  };
}

function makeMockStrategyRegistry() {
  const strategies = new Map<
    string,
    { id: string; name: string; level: string; status?: string }
  >();
  strategies.set("s-l0", { id: "s-l0", name: "Incubator", level: "L0_INCUBATE" });
  strategies.set("s-l1", { id: "s-l1", name: "Backtested", level: "L1_BACKTEST" });
  strategies.set("s-l2", { id: "s-l2", name: "Paper Tested", level: "L2_PAPER" });

  return {
    list: vi.fn(() => [...strategies.values()]),
    get: vi.fn((id: string) => strategies.get(id)),
    updateLevel: vi.fn((id: string, level: string) => {
      const s = strategies.get(id);
      if (s) s.level = level;
    }),
    updateStatus: vi.fn(),
    updateBacktest: vi.fn(),
  };
}

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

describe("L3 promotion gate", () => {
  let routes: Map<string, (req: unknown, res: HttpRes) => Promise<void>>;
  let eventStore: ReturnType<typeof makeInMemoryEventStore>;
  let strategyRegistry: ReturnType<typeof makeMockStrategyRegistry>;

  beforeEach(async () => {
    eventStore = makeInMemoryEventStore();
    strategyRegistry = makeMockStrategyRegistry();

    const captured = captureRoutes();
    const runtime = {
      services: new Map<string, unknown>([["fin-strategy-registry", strategyRegistry]]),
    };

    // Register strategy routes
    const { registerStrategyRoutes } = await import("../../src/core/routes-strategies.js");
    registerStrategyRoutes(captured.api as never, runtime as never, eventStore as never);

    // Register main routes (for approve endpoint)
    const { registerHttpRoutes } = await import("../../src/core/route-handlers.js");
    const { ExchangeRegistry } = await import("../../src/core/exchange-registry.js");
    const { RiskController } = await import("../../src/core/risk-controller.js");

    registerHttpRoutes({
      api: captured.api as never,
      gatherDeps: {
        registry: new ExchangeRegistry(),
        riskConfig: {
          enabled: true,
          maxAutoTradeUsd: 100,
          confirmThresholdUsd: 1000,
          maxDailyLossUsd: 5000,
          maxPositionPct: 20,
          maxLeverage: 10,
        } as never,
        eventStore: eventStore as never,
        runtime,
        pluginEntries: {},
      },
      eventStore: eventStore as never,
      healthStore: {
        upsert: vi.fn(),
        listAll: vi.fn(() => []),
        get: vi.fn(),
        recordPing: vi.fn(),
        recordError: vi.fn(),
      } as never,
      riskController: new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 1000,
        maxDailyLossUsd: 5000,
        maxPositionPct: 20,
        maxLeverage: 10,
      }),
      runtime,
      templates: {
        overview: "",
        tradingDesk: "",
        strategyLab: "",
        strategy: "",
        trader: "",
        setting: "",
      } as never,
    });

    routes = captured.routes;
  });

  it("L0→L1 promotion executes directly", async () => {
    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const req = mockReq({ id: "s-l0" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; to: string };
    expect(json.status).toBe("promoted");
    expect(json.to).toBe("L1_BACKTEST");
    expect(strategyRegistry.updateLevel).toHaveBeenCalledWith("s-l0", "L1_BACKTEST");
  });

  it("L1→L2 promotion executes directly", async () => {
    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const req = mockReq({ id: "s-l1" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; to: string };
    expect(json.status).toBe("promoted");
    expect(json.to).toBe("L2_PAPER");
  });

  it("L2→L3 promotion creates pending event (returns 202)", async () => {
    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const req = mockReq({ id: "s-l2" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(202);
    const json = res.getJson() as { status: string; targetLevel: string };
    expect(json.status).toBe("pending_approval");
    expect(json.targetLevel).toBe("L3_LIVE");

    // Strategy should NOT have been updated yet
    expect(strategyRegistry.updateLevel).not.toHaveBeenCalledWith("s-l2", "L3_LIVE");

    // Pending event should exist
    const pending = eventStore.listEvents({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]!.actionParams?.action).toBe("promote_l3");
  });

  it("L2→L3 approve triggers automatic updateLevel", async () => {
    // First create the pending promotion
    const promoteHandler = routes.get("/api/v1/finance/strategies/promote")!;
    await promoteHandler(mockReq({ id: "s-l2" }), mockRes());

    // Get the pending event
    const pending = eventStore.listEvents({ status: "pending" });
    const eventId = pending[0]!.id;

    // Approve it
    const approveHandler = routes.get("/api/v1/finance/events/approve")!;
    const res = mockRes();
    await approveHandler(mockReq({ id: eventId, action: "approve" }), res);

    expect(res.getStatus()).toBe(200);
    // Strategy should now be L3_LIVE
    expect(strategyRegistry.updateLevel).toHaveBeenCalledWith("s-l2", "L3_LIVE");
  });

  it("L2→L3 reject keeps strategy at L2", async () => {
    // Create pending promotion
    const promoteHandler = routes.get("/api/v1/finance/strategies/promote")!;
    await promoteHandler(mockReq({ id: "s-l2" }), mockRes());

    const pending = eventStore.listEvents({ status: "pending" });
    const eventId = pending[0]!.id;

    // Reject it
    const approveHandler = routes.get("/api/v1/finance/events/approve")!;
    const res = mockRes();
    await approveHandler(mockReq({ id: eventId, action: "reject", reason: "Not ready" }), res);

    expect(res.getStatus()).toBe(200);
    expect(strategyRegistry.updateLevel).not.toHaveBeenCalledWith("s-l2", "L3_LIVE");
    const strategy = strategyRegistry.get("s-l2");
    expect(strategy!.level).toBe("L2_PAPER");
  });

  it("L2→L3 pending event triggers NotificationRouter subscriber", async () => {
    const promoteHandler = routes.get("/api/v1/finance/strategies/promote")!;
    await promoteHandler(mockReq({ id: "s-l2" }), mockRes());

    // Verify the event was created with correct type for NotificationRouter
    const pending = eventStore.listEvents({ type: "trade_pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]!.type).toBe("trade_pending");
    expect(pending[0]!.status).toBe("pending");
    // NotificationRouter would pick up trade_pending and send inline buttons
  });
});
