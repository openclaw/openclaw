/**
 * Full trading flow integration tests.
 * Tests complete lifecycle: strategy creation → promotion → approval → execution.
 */

vi.mock("ccxt", () => ({}));

// sendMessageTelegram is now injected via constructor — no mock needed here.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildNotification } from "../../src/core/notification-router.js";
import type { HttpRes } from "../../src/types-http.js";

// ── Mock helpers (same pattern as approval-flow.test.ts) ──

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
          // ignore
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
    {
      id: string;
      name: string;
      level: string;
      status?: string;
      lastBacktest?: {
        totalReturn: number;
        sharpe: number;
        sortino: number;
        maxDrawdown: number;
        winRate: number;
        profitFactor: number;
        totalTrades: number;
        finalEquity: number;
        initialCapital: number;
        strategyId: string;
      };
      definition?: Record<string, unknown>;
      symbol?: string;
    }
  >();

  return {
    list: vi.fn((filter?: { level?: string }) => {
      const all = [...strategies.values()];
      if (filter?.level) return all.filter((s) => s.level === filter.level);
      return all;
    }),
    get: vi.fn((id: string) => strategies.get(id)),
    create: vi.fn((def: Record<string, unknown>) => {
      const record = {
        ...def,
        level: "L0_INCUBATE",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      strategies.set(def.id as string, record as ReturnType<typeof strategies.get> & object);
      return record;
    }),
    updateLevel: vi.fn((id: string, level: string) => {
      const s = strategies.get(id);
      if (s) s.level = level;
    }),
    updateStatus: vi.fn(),
    updateBacktest: vi.fn((id: string, result: Record<string, unknown>) => {
      const s = strategies.get(id);
      if (s) s.lastBacktest = result as (typeof s)["lastBacktest"];
    }),
  };
}

function makeMockPaperEngine() {
  const accounts = new Map<string, { id: string; name: string; equity: number }>();
  accounts.set("default", { id: "default", name: "Default", equity: 10000 });

  return {
    listAccounts: vi.fn(() => [...accounts.values()]),
    getAccountState: vi.fn((id: string) => {
      const acct = accounts.get(id);
      if (!acct) return null;
      return {
        ...acct,
        initialCapital: 10000,
        cash: acct.equity,
        positions: [],
        orders: [],
      };
    }),
    getSnapshots: vi.fn(() => []),
    getOrders: vi.fn(() => []),
    submitOrder: vi.fn((_accountId: string, order: Record<string, unknown>, _price: number) => ({
      id: `order-${Date.now()}`,
      ...order,
      status: "filled",
      fillPrice: _price,
      createdAt: Date.now(),
      filledAt: Date.now(),
    })),
    recordSnapshot: vi.fn(),
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

describe("Full trading flow integration", () => {
  let routes: Map<string, (req: unknown, res: HttpRes) => Promise<void>>;
  let eventStore: ReturnType<typeof makeInMemoryEventStore>;
  let strategyRegistry: ReturnType<typeof makeMockStrategyRegistry>;
  let paperEngine: ReturnType<typeof makeMockPaperEngine>;

  beforeEach(async () => {
    eventStore = makeInMemoryEventStore();
    strategyRegistry = makeMockStrategyRegistry();
    paperEngine = makeMockPaperEngine();

    const captured = captureRoutes();
    const runtime = {
      services: new Map<string, unknown>([
        ["fin-strategy-registry", strategyRegistry],
        ["fin-paper-engine", paperEngine],
      ]),
    };

    const { registerStrategyRoutes } = await import("../../src/core/routes-strategies.js");
    registerStrategyRoutes(captured.api as never, runtime, eventStore as never);

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

  // ── A: Strategy Lifecycle ──

  it("A1: strategy creation → backtest update → promote to L1", async () => {
    // Create a strategy via registry
    strategyRegistry.create({
      id: "test-strategy-1",
      name: "Test Alpha",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
    });

    // Update backtest result
    strategyRegistry.updateBacktest("test-strategy-1", {
      totalReturn: 0.15,
      sharpe: 1.2,
      sortino: 1.5,
      maxDrawdown: 0.08,
      winRate: 0.6,
      profitFactor: 1.8,
      totalTrades: 50,
      finalEquity: 11500,
      initialCapital: 10000,
      strategyId: "test-strategy-1",
    });

    // Promote L0 → L1
    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const res = mockRes();
    await handler(mockReq({ id: "test-strategy-1" }), res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; to: string };
    expect(json.status).toBe("promoted");
    expect(json.to).toBe("L1_BACKTEST");
  });

  it("A2: L1 strategy → promote L2 → paper engine is available for tick", async () => {
    strategyRegistry.create({
      id: "s-l1",
      name: "Paper Bound",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
    });
    strategyRegistry.updateLevel("s-l1", "L1_BACKTEST");

    // Promote L1 → L2
    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const res = mockRes();
    await handler(mockReq({ id: "s-l1" }), res);

    expect(res.getStatus()).toBe(200);
    expect((res.getJson() as { to: string }).to).toBe("L2_PAPER");

    // Verify paper engine is available for future ticks
    expect(paperEngine.listAccounts().length).toBeGreaterThan(0);
  });

  // ── B: L3 Approval Flow ──

  it("B1: L2→L3 promote returns 202 with pending event", async () => {
    strategyRegistry.create({
      id: "s-live",
      name: "Live Candidate",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["ETH/USDT"],
      timeframes: ["1h"],
    });
    strategyRegistry.updateLevel("s-live", "L2_PAPER");

    const handler = routes.get("/api/v1/finance/strategies/promote")!;
    const res = mockRes();
    await handler(mockReq({ id: "s-live" }), res);

    expect(res.getStatus()).toBe(202);
    expect((res.getJson() as { status: string }).status).toBe("pending_approval");

    const pending = eventStore.listEvents({ status: "pending" });
    expect(pending.length).toBe(1);
    expect((pending[0]!.actionParams as { action: string }).action).toBe("promote_l3");
  });

  it("B2: approve L3 promotion → strategy becomes L3_LIVE", async () => {
    strategyRegistry.create({
      id: "s-live2",
      name: "Approved Live",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
    });
    strategyRegistry.updateLevel("s-live2", "L2_PAPER");

    // Request promotion
    await routes.get("/api/v1/finance/strategies/promote")!(mockReq({ id: "s-live2" }), mockRes());

    // Get pending event and approve
    const pending = eventStore.listEvents({ status: "pending" });
    const approveRes = mockRes();
    await routes.get("/api/v1/finance/events/approve")!(
      mockReq({ id: pending[0]!.id, action: "approve" }),
      approveRes,
    );

    expect(approveRes.getStatus()).toBe(200);
    expect(strategyRegistry.updateLevel).toHaveBeenCalledWith("s-live2", "L3_LIVE");
  });

  it("B3: reject L3 promotion → strategy stays at L2", async () => {
    strategyRegistry.create({
      id: "s-reject",
      name: "Rejected",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
    });
    strategyRegistry.updateLevel("s-reject", "L2_PAPER");

    await routes.get("/api/v1/finance/strategies/promote")!(mockReq({ id: "s-reject" }), mockRes());

    const pending = eventStore.listEvents({ status: "pending" });
    const rejectRes = mockRes();
    await routes.get("/api/v1/finance/events/approve")!(
      mockReq({ id: pending[0]!.id, action: "reject", reason: "Not ready" }),
      rejectRes,
    );

    expect(rejectRes.getStatus()).toBe(200);
    expect(strategyRegistry.updateLevel).not.toHaveBeenCalledWith("s-reject", "L3_LIVE");
  });

  // ── C: Trade Approval ──

  it("C1: large trade triggers risk confirm → pending → approve → execute", async () => {
    // Place a large order that exceeds maxAutoTradeUsd (100) but under confirmThreshold (1000)
    const orderHandler = routes.get("/api/v1/finance/orders")!;
    const res = mockRes();
    await orderHandler(
      mockReq({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.01,
        price: 50000, // 0.01 * 50000 = 500 USD → confirm tier
        type: "market",
      }),
      res,
    );

    expect(res.getStatus()).toBe(202);
    const json = res.getJson() as { status: string; eventId: string };
    expect(json.status).toBe("pending_approval");

    // Approve the trade
    const approveRes = mockRes();
    await routes.get("/api/v1/finance/events/approve")!(
      mockReq({ id: json.eventId, action: "approve" }),
      approveRes,
    );
    expect(approveRes.getStatus()).toBe(200);
  });

  // ── D: Daily Brief ──

  it("D1: DailyBriefScheduler generates brief and writes to eventStore", async () => {
    const { DailyBriefScheduler } = await import("../../src/core/daily-brief-scheduler.js");

    const scheduler = new DailyBriefScheduler({
      paperEngine: paperEngine as never,
      strategyRegistry: strategyRegistry as never,
      eventStore: eventStore as never,
    });

    const brief = await scheduler.generateBrief();

    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(brief.portfolioChange.totalEquity).toBe(10000);

    // Verify event was written
    const systemEvents = eventStore.listEvents({ type: "system" });
    expect(systemEvents.some((e) => e.title === "Daily Brief")).toBe(true);
  });

  // ── E: Event Notification ──

  it("E1: trade_pending event generates notification with approve/reject buttons", () => {
    const event = {
      id: "evt-1-test",
      type: "trade_pending" as const,
      title: "BUY 0.5 BTC/USDT",
      detail: "Trade value $25000",
      timestamp: Date.now(),
      status: "pending" as const,
    };

    const notification = buildNotification(event);

    expect(notification.level).toBe("action_required");
    expect(notification.text).toContain("BUY 0.5 BTC/USDT");
    expect(notification.buttons).toBeDefined();
    expect(notification.buttons![0]).toHaveLength(2);
    expect(notification.buttons![0]![0]!.callback_data).toContain("fin_approve:");
    expect(notification.buttons![0]![1]!.callback_data).toContain("fin_reject:");
  });
});
