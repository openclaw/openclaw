/**
 * Integration tests for Setting Tab CRUD HTTP routes.
 * Tests the route handler logic by calling handlers directly with mock req/res.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import { RiskController } from "../../src/core/risk-controller.js";
import type { HttpRes } from "../../src/types-http.js";
import type { TradingRiskConfig, ExchangeConfig } from "../../src/types.js";

// Mock ccxt (used by ExchangeRegistry.getInstance)
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
    loadMarkets = vi.fn(async () => ({ "BTC/USDT": {}, "ETH/USDT": {} }));
    fetchBalance = vi.fn(async () => ({
      free: { BTC: 0.5, USDT: 1000 },
      total: { BTC: 0.5, USDT: 1000 },
    }));
  }
  return { binance: MockExchange, okx: MockExchange };
});

// ── Mock helpers ──

function makeRiskConfig(): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 5000,
    maxPositionPct: 20,
    maxLeverage: 10,
  };
}

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
  const headers: Record<string, string> = {};
  const res: HttpRes & { getStatus: () => number; getJson: () => unknown } = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      Object.assign(headers, h);
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

/** Minimal mock for ExchangeHealthStore. */
function mockHealthStore() {
  return {
    upsert: vi.fn(),
    listAll: vi.fn(() => []),
    get: vi.fn(),
    recordPing: vi.fn(),
    recordError: vi.fn(),
  };
}

/** Minimal mock for AgentEventSqliteStore. */
function mockEventStore() {
  const events: Array<Record<string, unknown>> = [];
  return {
    addEvent: vi.fn((input: Record<string, unknown>) => {
      const event = { ...input, id: `evt-${events.length + 1}`, timestamp: Date.now() };
      events.push(event);
      return event;
    }),
    listEvents: vi.fn(() => events),
    pendingCount: vi.fn(() => events.filter((e) => e.status === "pending").length),
    getEvent: vi.fn((id: string) => events.find((e) => e.id === id)),
    approve: vi.fn(),
    reject: vi.fn(),
  };
}

// ── We test by importing registerSettingRoutes and capturing registered handlers ──

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

describe("routes-setting integration", () => {
  let routes: Map<string, (req: unknown, res: HttpRes) => Promise<void>>;
  let registry: ExchangeRegistry;
  let riskController: RiskController;
  let healthStore: ReturnType<typeof mockHealthStore>;
  let eventStore: ReturnType<typeof mockEventStore>;

  beforeEach(async () => {
    registry = new ExchangeRegistry();
    riskController = new RiskController(makeRiskConfig());
    healthStore = mockHealthStore();
    eventStore = mockEventStore();

    const captured = captureRoutes();

    // Dynamically import to avoid issues with module resolution
    const { registerSettingRoutes } = await import("../../src/core/routes-setting.js");
    registerSettingRoutes({
      api: captured.api as unknown as Parameters<typeof registerSettingRoutes>[0]["api"],
      registry,
      healthStore: healthStore as unknown as Parameters<
        typeof registerSettingRoutes
      >[0]["healthStore"],
      riskController,
      eventStore: eventStore as unknown as Parameters<
        typeof registerSettingRoutes
      >[0]["eventStore"],
      runtime: { services: new Map() },
    });

    routes = captured.routes;
  });

  // ── POST /api/v1/finance/exchanges — Add exchange ──

  it("should add exchange and return 201 with id", async () => {
    const handler = routes.get("/api/v1/finance/exchanges")!;
    expect(handler).toBeDefined();

    const req = mockReq({ exchange: "binance", apiKey: "key1", secret: "sec1" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(201);
    const json = res.getJson() as { id: string; exchange: string; testnet: boolean };
    expect(json.exchange).toBe("binance");
    expect(json.testnet).toBe(false);
    expect(json.id).toBeDefined();

    // Verify exchange was added to registry
    expect(registry.listExchanges()).toHaveLength(1);
  });

  it("should reject add exchange with invalid exchange id", async () => {
    const handler = routes.get("/api/v1/finance/exchanges")!;
    const req = mockReq({ exchange: "not-valid", apiKey: "k", secret: "s" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(400);
  });

  it("should reject add exchange with missing apiKey", async () => {
    const handler = routes.get("/api/v1/finance/exchanges")!;
    const req = mockReq({ exchange: "binance", secret: "s" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(400);
  });

  it("should initialize health record when adding exchange", async () => {
    const handler = routes.get("/api/v1/finance/exchanges")!;
    const req = mockReq({ exchange: "binance", apiKey: "k", secret: "s" });
    const res = mockRes();
    await handler(req, res);

    expect(healthStore.upsert).toHaveBeenCalledOnce();
  });

  it("should emit system event when adding exchange", async () => {
    const handler = routes.get("/api/v1/finance/exchanges")!;
    const req = mockReq({ exchange: "okx", apiKey: "k", secret: "s", label: "my-okx" });
    const res = mockRes();
    await handler(req, res);

    expect(eventStore.addEvent).toHaveBeenCalledOnce();
    expect(eventStore.addEvent.mock.calls[0]![0]).toMatchObject({
      type: "system",
      status: "completed",
    });
  });

  // ── POST /api/v1/finance/exchanges/test — Test exchange connection ──

  it("should test exchange connection and return success", async () => {
    // First add an exchange
    registry.addExchange("test-binance", {
      exchange: "binance",
      apiKey: "k",
      secret: "s",
    });

    const handler = routes.get("/api/v1/finance/exchanges/test")!;
    expect(handler).toBeDefined();

    const req = mockReq({ id: "test-binance" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { success: boolean; latencyMs: number };
    expect(json.success).toBe(true);
    expect(json.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should return 404 when testing non-existent exchange", async () => {
    const handler = routes.get("/api/v1/finance/exchanges/test")!;
    const req = mockReq({ id: "nonexistent" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(404);
  });

  it("should return 400 when testing without id", async () => {
    const handler = routes.get("/api/v1/finance/exchanges/test")!;
    const req = mockReq({});
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(400);
  });

  // ── POST /api/v1/finance/exchanges/remove — Remove exchange ──

  it("should remove exchange and return 200", async () => {
    registry.addExchange("to-remove", {
      exchange: "binance",
      apiKey: "k",
      secret: "s",
    });
    expect(registry.listExchanges()).toHaveLength(1);

    const handler = routes.get("/api/v1/finance/exchanges/remove")!;
    expect(handler).toBeDefined();

    const req = mockReq({ id: "to-remove" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; id: string };
    expect(json.status).toBe("removed");
    expect(registry.listExchanges()).toHaveLength(0);
  });

  it("should return 404 when removing non-existent exchange", async () => {
    const handler = routes.get("/api/v1/finance/exchanges/remove")!;
    const req = mockReq({ id: "not-here" });
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(404);
  });

  // ── PUT /api/v1/finance/config/trading — Update risk config ──

  it("should update risk config and return 200", async () => {
    const handler = routes.get("/api/v1/finance/config/trading")!;
    expect(handler).toBeDefined();

    const newConfig = {
      maxAutoTradeUsd: 200,
      confirmThresholdUsd: 2000,
      maxDailyLossUsd: 10000,
      maxPositionPct: 30,
      maxLeverage: 5,
    };
    const req = mockReq(newConfig);
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(200);
    const json = res.getJson() as { status: string; config: Record<string, unknown> };
    expect(json.status).toBe("updated");
    expect(json.config.maxAutoTradeUsd).toBe(200);
  });

  it("should reject invalid risk config (maxAutoTrade >= confirmThreshold)", async () => {
    const handler = routes.get("/api/v1/finance/config/trading")!;
    const badConfig = {
      maxAutoTradeUsd: 5000,
      confirmThresholdUsd: 1000,
      maxDailyLossUsd: 10000,
      maxPositionPct: 30,
      maxLeverage: 5,
    };
    const req = mockReq(badConfig);
    const res = mockRes();
    await handler(req, res);

    expect(res.getStatus()).toBe(400);
  });
});
