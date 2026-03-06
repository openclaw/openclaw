import { Readable } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSettingRoutes } from "../../src/core/routes-setting.js";
import type { SettingRouteDeps } from "../../src/core/routes-setting.js";
import type { HttpReq, HttpRes } from "../../src/types-http.js";

// ── Helpers ──

function mockReq(body: unknown): HttpReq {
  const data = JSON.stringify(body);
  const stream = new Readable({
    read() {
      this.push(data);
      this.push(null);
    },
  });
  return Object.assign(stream, {
    method: "POST",
    url: "/test",
    headers: { "content-type": "application/json" },
  }) as unknown as HttpReq;
}

function mockRes(): HttpRes & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: null as unknown,
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      if (body) res._body = JSON.parse(body);
    },
  };
  return res as unknown as HttpRes & { _status: number; _body: unknown };
}

function createDeps(): SettingRouteDeps & {
  routes: Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>;
} {
  const routes = new Map<string, (req: HttpReq, res: HttpRes) => Promise<void>>();
  return {
    routes,
    api: {
      registerHttpRoute: ({
        path,
        handler,
      }: {
        path: string;
        handler: (req: HttpReq, res: HttpRes) => Promise<void>;
      }) => {
        routes.set(path, handler);
      },
    } as unknown as SettingRouteDeps["api"],
    registry: {
      addExchange: vi.fn(),
      listExchanges: vi.fn(() => [{ id: "binance-1", exchange: "binance" }]),
      getInstance: vi.fn(async () => ({
        loadMarkets: async () => ({ "BTC/USDT": {} }),
        fetchBalance: async () => ({ free: { USDT: 1000 }, total: { USDT: 1000 } }),
      })),
      removeExchange: vi.fn((id: string) => id === "binance-1"),
    } as unknown as SettingRouteDeps["registry"],
    healthStore: {
      upsert: vi.fn(),
      recordPing: vi.fn(),
      recordError: vi.fn(),
    } as unknown as SettingRouteDeps["healthStore"],
    riskController: {
      updateConfig: vi.fn(),
    } as unknown as SettingRouteDeps["riskController"],
    eventStore: {
      addEvent: vi.fn(),
    } as unknown as SettingRouteDeps["eventStore"],
    runtime: {
      services: {
        get: vi.fn(() => ({ update: vi.fn() })),
      },
    } as unknown as SettingRouteDeps["runtime"],
  };
}

describe("registerSettingRoutes", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
    registerSettingRoutes(deps);
  });

  it("registers all 11 setting routes", () => {
    expect(deps.routes.size).toBe(11);
    expect(deps.routes.has("/api/v1/finance/exchanges")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/exchanges/test")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/exchanges/remove")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/trading")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/agent")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/gates")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/notifications")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/notification-filters")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/export")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/import")).toBe(true);
    expect(deps.routes.has("/api/v1/finance/config/reset")).toBe(true);
  });

  // ── POST /exchanges ──

  describe("POST /exchanges", () => {
    it("creates exchange with valid input", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges")!;
      const req = mockReq({ exchange: "binance", apiKey: "key1", secret: "sec1", testnet: true });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(201);
      expect((res._body as Record<string, unknown>).exchange).toBe("binance");
      expect(deps.registry.addExchange).toHaveBeenCalled();
      expect(deps.healthStore.upsert).toHaveBeenCalled();
      expect(deps.eventStore.addEvent).toHaveBeenCalled();
    });

    it("returns 400 for invalid input", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges")!;
      const req = mockReq({ exchange: "" }); // invalid: empty exchange
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
    });
  });

  // ── POST /exchanges/test ──

  describe("POST /exchanges/test", () => {
    it("tests exchange connection successfully", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/test")!;
      const req = mockReq({ id: "binance-1" });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).success).toBe(true);
      expect(deps.healthStore.recordPing).toHaveBeenCalled();
    });

    it("returns 400 for missing id", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/test")!;
      const req = mockReq({});
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
    });

    it("returns 404 for unknown exchange", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/test")!;
      const req = mockReq({ id: "nonexist" });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(404);
    });
  });

  // ── POST /exchanges/remove ──

  describe("POST /exchanges/remove", () => {
    it("removes existing exchange", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/remove")!;
      const req = mockReq({ id: "binance-1" });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).status).toBe("removed");
    });

    it("returns 404 for unknown exchange", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/remove")!;
      const req = mockReq({ id: "nonexist" });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(404);
    });

    it("returns 400 for missing id", async () => {
      const handler = deps.routes.get("/api/v1/finance/exchanges/remove")!;
      const req = mockReq({});
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
    });
  });

  // ── PUT /config/trading ──

  describe("PUT /config/trading", () => {
    it("updates risk config with valid input", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/trading")!;
      const req = mockReq({
        maxAutoTradeUsd: 500,
        confirmThresholdUsd: 5000,
        maxDailyLossUsd: 2000,
        maxPositionPct: 25,
        maxLeverage: 3,
      });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).status).toBe("updated");
      expect(deps.riskController.updateConfig).toHaveBeenCalled();
    });

    it("returns 400 for invalid risk config (missing required fields)", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/trading")!;
      const req = mockReq({ maxAutoTradeUsd: 500 }); // missing other required fields
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
    });

    it("returns 400 when maxAutoTradeUsd >= confirmThresholdUsd", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/trading")!;
      const req = mockReq({
        maxAutoTradeUsd: 5000,
        confirmThresholdUsd: 500, // violates refinement
        maxDailyLossUsd: 2000,
        maxPositionPct: 25,
        maxLeverage: 3,
      });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(400);
    });
  });

  // ── PUT /config/agent ──

  describe("PUT /config/agent", () => {
    it("updates agent behavior config", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/agent")!;
      const req = mockReq({
        heartbeatIntervalMs: 60_000,
        discoveryEnabled: true,
        evolutionEnabled: true,
        mutationRate: 0.1,
        maxConcurrentStrategies: 5,
      });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).status).toBe("updated");
    });
  });

  // ── PUT /config/gates ──

  describe("PUT /config/gates", () => {
    it("updates promotion gate thresholds", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/gates")!;
      const req = mockReq({
        l0l1: { minDays: 7, minSharpe: 0.5, maxDrawdown: -0.2, minWinRate: 0.4, minTrades: 10 },
        l1l2: { minDays: 30, minSharpe: 1.0, maxDrawdown: -0.15, minWinRate: 0.5, minTrades: 50 },
        l2l3: { minDays: 90, minSharpe: 1.5, maxDrawdown: -0.1, minWinRate: 0.55, minTrades: 100 },
      });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).status).toBe("updated");
    });
  });

  // ── PUT /config/notifications ──

  describe("PUT /config/notifications", () => {
    it("updates Telegram notification config", async () => {
      const handler = deps.routes.get("/api/v1/finance/config/notifications")!;
      const req = mockReq({
        telegramBotToken: "123456:ABC-DEF",
        telegramChatId: "-1001234567890",
      });
      const res = mockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect((res._body as Record<string, unknown>).status).toBe("updated");
    });
  });
});
