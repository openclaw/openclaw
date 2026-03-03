import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type RouteHandler = (
  req: unknown,
  res: {
    writeHead: (statusCode: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
    write?: (chunk: string) => boolean;
  },
) => Promise<void> | void;

function createResponseRecorder() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body = "";
  return {
    res: {
      writeHead(status: number, nextHeaders: Record<string, string>) {
        statusCode = status;
        headers = nextHeaders;
      },
      end(nextBody: string) {
        body = nextBody;
      },
    },
    read() {
      return { statusCode, headers, body };
    },
  };
}

/** Create a streaming response recorder (for SSE endpoints). */
function createStreamRecorder() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const chunks: string[] = [];
  return {
    res: {
      writeHead(status: number, nextHeaders: Record<string, string>) {
        statusCode = status;
        headers = nextHeaders;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {},
    },
    read() {
      return { statusCode, headers, chunks };
    },
  };
}

/** Create a mock request with `on("close", cb)` for SSE disconnect simulation. */
function createMockReq() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    req: {
      on(event: string, cb: () => void) {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      },
    },
    /** Simulate client disconnect. */
    disconnect() {
      for (const cb of listeners["close"] ?? []) cb();
    },
  };
}

function createFakeApi(): {
  api: OpenClawPluginApi;
  services: Map<string, unknown>;
  routes: Map<string, RouteHandler>;
} {
  const services = new Map<string, unknown>();
  const routes = new Map<string, RouteHandler>();
  const api = {
    id: "fin-core",
    name: "Financial Core",
    source: "test",
    config: {
      financial: {
        exchanges: {
          "main-binance": {
            exchange: "binance",
            apiKey: "k",
            secret: "s",
            testnet: true,
          },
        },
        trading: {
          enabled: true,
          maxAutoTradeUsd: 220,
          confirmThresholdUsd: 900,
          maxDailyLossUsd: 1800,
          maxPositionPct: 35,
          maxLeverage: 2,
        },
      },
      plugins: {
        entries: {
          "fin-core": { enabled: true },
          "findoo-datahub-plugin": { enabled: true },
          "fin-monitoring": { enabled: false },
        },
      },
    },
    pluginConfig: {},
    runtime: { services, version: "test" },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn((entry: { path: string; handler: RouteHandler }) => {
      routes.set(entry.path, entry.handler);
    }),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn((svc: { id: string; instance?: unknown }) => {
      services.set(svc.id, svc.instance ?? svc);
    }),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (input: string) => input,
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return { api, services, routes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Inject mock fin-* services into the runtime so gatherTradingData() can aggregate. */
function injectMockTradingServices(services: Map<string, unknown>) {
  const mockAccount = {
    id: "paper-1",
    name: "Test Account",
    initialCapital: 10000,
    cash: 5000,
    equity: 12500,
    positions: [
      {
        symbol: "BTC/USDT",
        side: "long",
        quantity: 0.5,
        entryPrice: 40000,
        currentPrice: 45000,
        unrealizedPnl: 2500,
      },
    ],
    orders: [
      {
        id: "o-1",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 0.5,
        fillPrice: 40000,
        commission: 0.04,
        status: "filled",
        strategyId: "sma-1",
        createdAt: Date.now() - 3600_000,
        filledAt: Date.now() - 3600_000,
      },
    ],
  };

  services.set("fin-paper-engine", {
    listAccounts: () => [{ id: "paper-1", name: "Test Account", equity: 12500 }],
    getAccountState: (id: string) => (id === "paper-1" ? mockAccount : null),
    getSnapshots: () => [
      {
        timestamp: Date.now() - 86400_000,
        equity: 10000,
        cash: 10000,
        positionsValue: 0,
        dailyPnl: 0,
        dailyPnlPct: 0,
      },
      {
        timestamp: Date.now(),
        equity: 12500,
        cash: 5000,
        positionsValue: 7500,
        dailyPnl: 250,
        dailyPnlPct: 2.5,
      },
    ],
    getOrders: () => mockAccount.orders,
  });

  services.set("fin-strategy-registry", {
    list: () => [
      {
        id: "sma-1",
        name: "SMA Crossover",
        level: "L2_PAPER",
        lastBacktest: {
          totalReturn: 15.5,
          sharpe: 1.23,
          sortino: 1.8,
          maxDrawdown: 8.2,
          winRate: 55,
          profitFactor: 1.45,
          totalTrades: 42,
          finalEquity: 11550,
          initialCapital: 10000,
          strategyId: "sma-1",
        },
      },
    ],
  });

  services.set("fin-fund-manager", {
    getState: () => ({
      allocations: [{ strategyId: "sma-1", capitalUsd: 8000, weightPct: 80 }],
      totalCapital: 10000,
    }),
  });
}

describe("fin-core plugin", () => {
  it("registers core services and preloads configured exchanges", () => {
    const { api, services } = createFakeApi();
    plugin.register(api);

    const registry = services.get("fin-exchange-registry") as {
      listExchanges: () => Array<{ id: string; exchange: string; testnet: boolean }>;
    };

    expect(registry).toBeDefined();
    expect(registry.listExchanges()).toEqual([
      {
        id: "main-binance",
        exchange: "binance",
        testnet: true,
      },
    ]);
    expect(services.has("fin-risk-controller")).toBe(true);
  });

  it("serves finance config API with sanitized payload", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/config");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(output.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      exchanges: [
        {
          id: "main-binance",
          exchange: "binance",
          testnet: true,
        },
      ],
      trading: {
        enabled: true,
        maxAutoTradeUsd: 220,
        confirmThresholdUsd: 900,
        maxDailyLossUsd: 1800,
        maxPositionPct: 35,
        maxLeverage: 2,
      },
    });

    const plugins = payload.plugins as { total: number; enabled: number; entries: unknown[] };
    expect(plugins.total).toBeGreaterThan(0);
    expect(plugins.enabled).toBeGreaterThan(0);
    expect(plugins.entries.length).toBeGreaterThan(0);
  });

  it("renders finance dashboard route (redirects to overview)", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/dashboard/finance");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(302);
    expect(output.headers["Location"]).toBe("/dashboard/overview");
  });

  // ── SSE Endpoint Tests ──

  it("SSE endpoint sets correct response headers", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/trading/stream");
    expect(route).toBeDefined();

    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    const output = stream.read();
    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("text/event-stream");
    expect(output.headers["Cache-Control"]).toBe("no-cache");
    expect(output.headers["Connection"]).toBe("keep-alive");
  });

  it("SSE endpoint sends initial data immediately on connection", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/trading/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    const output = stream.read();
    // Should have at least one chunk (the immediate push)
    expect(output.chunks.length).toBeGreaterThanOrEqual(1);

    // First chunk must be SSE-formatted
    const first = output.chunks[0]!;
    expect(first).toMatch(/^data: \{.*\}\n\n$/);

    // Parse the JSON payload
    const payload = JSON.parse(first.replace("data: ", "").trim());
    expect(payload).toHaveProperty("summary");
    expect(payload).toHaveProperty("positions");
    expect(payload).toHaveProperty("orders");
    expect(payload).toHaveProperty("snapshots");
    expect(payload).toHaveProperty("strategies");
    expect(payload).toHaveProperty("backtests");
    expect(payload).toHaveProperty("allocations");
  });

  it("SSE endpoint pushes periodic updates via setInterval", async () => {
    vi.useFakeTimers();

    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/trading/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    // After initial push, advance 10 seconds
    expect(stream.read().chunks.length).toBe(1);

    vi.advanceTimersByTime(10_000);
    expect(stream.read().chunks.length).toBe(2);

    vi.advanceTimersByTime(10_000);
    expect(stream.read().chunks.length).toBe(3);

    // All chunks are valid SSE data frames
    for (const chunk of stream.read().chunks) {
      expect(chunk).toMatch(/^data: \{.*\}\n\n$/);
    }

    vi.useRealTimers();
  });

  it("SSE endpoint cleans up interval on client disconnect", async () => {
    vi.useFakeTimers();

    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/trading/stream");
    const stream = createStreamRecorder();
    const { req, disconnect } = createMockReq();
    await route?.(req, stream.res);

    expect(stream.read().chunks.length).toBe(1);

    // Simulate client disconnect
    disconnect();

    // After disconnect, advancing timers should NOT produce new chunks
    vi.advanceTimersByTime(30_000);
    expect(stream.read().chunks.length).toBe(1);

    vi.useRealTimers();
  });

  // ── Trading Data Aggregation Tests ──

  it("gatherTradingData() aggregates data from paper engine, strategy registry, and fund manager", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    // Call the REST endpoint which uses gatherTradingData()
    const route = routes.get("/api/v1/finance/trading");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body) as Record<string, unknown>;

    // Summary
    const summary = data.summary as Record<string, unknown>;
    expect(summary.totalEquity).toBe(12500);
    expect(summary.positionCount).toBe(1);
    expect(summary.strategyCount).toBe(1);
    expect(summary.avgSharpe).toBeCloseTo(1.23, 2);

    // Positions
    const positions = data.positions as Array<Record<string, unknown>>;
    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe("BTC/USDT");
    expect(positions[0]!.unrealizedPnl).toBe(2500);

    // Orders
    const orders = data.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("filled");

    // Snapshots sorted by timestamp
    const snapshots = data.snapshots as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(2);
    expect((snapshots[0] as { timestamp: number }).timestamp).toBeLessThan(
      (snapshots[1] as { timestamp: number }).timestamp,
    );

    // Strategies
    const strategies = data.strategies as Array<Record<string, unknown>>;
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toBe("SMA Crossover");
    expect(strategies[0]!.sharpe).toBe(1.23);

    // Allocations
    const alloc = data.allocations as Record<string, unknown>;
    expect(alloc.totalAllocated).toBe(8000);
    expect(alloc.cashReserve).toBe(2000);
    expect(alloc.totalCapital).toBe(10000);
  });

  it("gatherTradingData() returns safe defaults when no services are available", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);
    // Don't inject any mock services — simulates fresh startup

    const route = routes.get("/api/v1/finance/trading");
    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const data = JSON.parse(recorder.read().body) as Record<string, unknown>;

    const summary = data.summary as Record<string, unknown>;
    expect(summary.totalEquity).toBe(0);
    expect(summary.positionCount).toBe(0);
    expect(summary.strategyCount).toBe(0);
    expect(data.positions).toEqual([]);
    expect(data.orders).toEqual([]);
  });

  // ── SSE with Real Trading Data ──

  it("SSE endpoint includes aggregated trading data from mock services", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    const route = routes.get("/api/v1/finance/trading/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    const first = stream.read().chunks[0]!;
    const payload = JSON.parse(first.replace("data: ", "").trim()) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    expect(summary.totalEquity).toBe(12500);
    expect(summary.positionCount).toBe(1);
    expect((payload.strategies as unknown[]).length).toBe(1);
  });

  // ── Trading Dashboard Route Tests ──

  it("trading dashboard route redirects to trading-desk", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/dashboard/trading");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(302);
    expect(output.headers["Location"]).toBe("/dashboard/trading-desk");
  });

  it("trading dashboard redirect preserves route registration", () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    // Old trading route still registered (as redirect)
    expect(routes.has("/dashboard/trading")).toBe(true);
    // New unified route registered
    expect(routes.has("/dashboard/trading-desk")).toBe(true);
  });

  it("unified trading-desk dashboard renders HTML with SSE connections", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    const route = routes.get("/dashboard/trading-desk");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toContain("text/html");

    // Key structural elements
    expect(output.body).toContain("Trading Desk");
    expect(output.body).toContain("EventSource");
    expect(output.body).toContain("connectSSE");
    // CSS and data injected (placeholders replaced)
    expect(output.body).not.toContain("/*__SHARED_CSS__*/");
    expect(output.body).not.toMatch(/\/\*__PAGE_DATA__\*\/\s*\{\}/);
  });

  // ── Config SSE Endpoint Tests ──

  it("Config SSE endpoint registers correctly", () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);
    expect(routes.has("/api/v1/finance/config/stream")).toBe(true);
  });

  it("Config SSE endpoint sets correct response headers", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/config/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    const output = stream.read();
    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("text/event-stream");
    expect(output.headers["Cache-Control"]).toBe("no-cache");
    expect(output.headers["Connection"]).toBe("keep-alive");
  });

  it("Config SSE sends initial data immediately", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/config/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    const output = stream.read();
    expect(output.chunks.length).toBeGreaterThanOrEqual(1);
    const first = output.chunks[0]!;
    expect(first).toMatch(/^data: \{.*\}\n\n$/);
    const payload = JSON.parse(first.replace("data: ", "").trim());
    expect(payload).toHaveProperty("exchanges");
    expect(payload).toHaveProperty("trading");
    expect(payload).toHaveProperty("plugins");
  });

  it("Config SSE pushes at 30s interval", async () => {
    vi.useFakeTimers();
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/config/stream");
    const stream = createStreamRecorder();
    const { req } = createMockReq();
    await route?.(req, stream.res);

    expect(stream.read().chunks.length).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(stream.read().chunks.length).toBe(2);
    vi.advanceTimersByTime(30_000);
    expect(stream.read().chunks.length).toBe(3);

    vi.useRealTimers();
  });

  it("Config SSE cleans up on disconnect", async () => {
    vi.useFakeTimers();
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/config/stream");
    const stream = createStreamRecorder();
    const { req, disconnect } = createMockReq();
    await route?.(req, stream.res);

    expect(stream.read().chunks.length).toBe(1);
    disconnect();
    vi.advanceTimersByTime(60_000);
    expect(stream.read().chunks.length).toBe(1);

    vi.useRealTimers();
  });

  // ── Finance Dashboard HTML Validation ──

  it("unified overview dashboard renders HTML with config data", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    const route = routes.get("/dashboard/overview");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toContain("text/html");

    // CSS and data injected (placeholders replaced)
    expect(output.body).not.toContain("/*__SHARED_CSS__*/");
    expect(output.body).not.toMatch(/\/\*__PAGE_DATA__\*\/\s*\{\}/);
    // Key structural elements
    expect(output.body).toContain("Overview");
    expect(output.body).toContain("connectSSE");
  });

  // ── Route Registration Completeness ──

  it("registers all expected HTTP routes", () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const expectedRoutes = [
      // Existing read routes
      "/api/v1/finance/config",
      "/api/v1/finance/config/stream",
      "/api/v1/finance/trading",
      "/api/v1/finance/trading/stream",
      "/dashboard/finance",
      "/dashboard/trading",
      // Unified dashboard routes
      "/dashboard/overview",
      "/dashboard/trading-desk",
      "/dashboard/strategy-lab",
      // P0-1: Write endpoints
      "/api/v1/finance/orders",
      "/api/v1/finance/orders/cancel",
      "/api/v1/finance/positions/close",
      "/api/v1/finance/alerts",
      "/api/v1/finance/alerts/create",
      "/api/v1/finance/alerts/remove",
      // P0-2: Agent events
      "/api/v1/finance/events",
      "/api/v1/finance/events/stream",
      // P0-3: Emergency stop
      "/api/v1/finance/emergency-stop",
      // P0-4: Strategy management
      "/api/v1/finance/strategies",
      "/api/v1/finance/strategies/pause",
      "/api/v1/finance/strategies/resume",
      "/api/v1/finance/strategies/kill",
      "/api/v1/finance/strategies/promote",
      "/api/v1/finance/strategies/pause-all",
      "/api/v1/finance/strategies/backtest-all",
      // P0-5: Approval flow
      "/api/v1/finance/events/approve",
      // Risk evaluation
      "/api/v1/finance/risk/evaluate",
      // AI chat
      "/api/v1/finance/ai/chat",
    ];

    for (const path of expectedRoutes) {
      expect(routes.has(path), `route ${path} should be registered`).toBe(true);
    }
  });

  // ── P0 Write Endpoint Tests ──

  /** Create a mock POST request with JSON body and close event support. */
  function createPostReq(body: Record<string, unknown>) {
    const json = JSON.stringify(body);
    const buf = Buffer.from(json, "utf-8");
    const listeners: Record<string, Array<(data?: Buffer) => void>> = {};
    return {
      req: {
        method: "POST",
        on(event: string, cb: (data?: Buffer) => void) {
          listeners[event] = listeners[event] ?? [];
          listeners[event].push(cb);
          // Auto-emit data + end for body parsing
          if (event === "data") {
            queueMicrotask(() => cb(buf));
          }
          if (event === "end") {
            queueMicrotask(() => cb());
          }
        },
      },
      disconnect() {
        for (const cb of (listeners["close"] ?? []) as Array<() => void>) cb();
      },
    };
  }

  /** Helper: inject full mock trading services with submitOrder support. */
  function injectFullMockServices(services: Map<string, unknown>) {
    injectMockTradingServices(services);

    // Extend paper engine with submitOrder
    const existing = services.get("fin-paper-engine") as Record<string, unknown>;
    services.set("fin-paper-engine", {
      ...existing,
      submitOrder: (_accountId: string, order: Record<string, unknown>, _price: number) => ({
        id: "order-test-1",
        symbol: order.symbol,
        side: order.side,
        type: order.type ?? "market",
        quantity: order.quantity,
        status: "filled",
        fillPrice: _price || 45000,
        createdAt: Date.now(),
      }),
    });

    // Add alert engine
    const alerts = new Map<
      string,
      { id: string; condition: Record<string, unknown>; createdAt: string; message?: string }
    >();
    let alertCounter = 0;
    services.set("fin-alert-engine", {
      addAlert: (condition: Record<string, unknown>, message?: string) => {
        const id = `alert-${++alertCounter}`;
        alerts.set(id, { id, condition, createdAt: new Date().toISOString(), message });
        return id;
      },
      removeAlert: (id: string) => {
        return alerts.delete(id);
      },
      listAlerts: () => [...alerts.values()],
    });

    // Extend strategy registry with get/updateLevel/updateStatus
    services.set("fin-strategy-registry", {
      list: () => [
        {
          id: "sma-1",
          name: "SMA Crossover",
          level: "L2_PAPER",
          status: "running",
          lastBacktest: {
            totalReturn: 15.5,
            sharpe: 1.23,
            sortino: 1.8,
            maxDrawdown: 8.2,
            winRate: 55,
            profitFactor: 1.45,
            totalTrades: 42,
            finalEquity: 11550,
            initialCapital: 10000,
            strategyId: "sma-1",
          },
        },
      ],
      get: (id: string) =>
        id === "sma-1"
          ? { id: "sma-1", name: "SMA Crossover", level: "L2_PAPER", status: "running" }
          : undefined,
      updateLevel: vi.fn(),
      updateStatus: vi.fn(),
    });
  }

  // ── Orders ──

  it("POST /orders places an order via paper engine", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/orders");
    expect(route).toBeDefined();

    // Use small amount to stay within auto tier: 0.001 * 1000 = $1 < maxAutoTradeUsd ($220)
    const { req } = createPostReq({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 0.001,
      currentPrice: 1000,
    });

    const recorder = createResponseRecorder();
    // Add write method for compatibility
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(201);
    const data = JSON.parse(output.body);
    expect(data.symbol).toBe("BTC/USDT");
    expect(data.status).toBe("filled");
  });

  it("POST /orders returns 400 on missing fields", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/orders");
    const { req } = createPostReq({ symbol: "BTC/USDT" }); // missing side, quantity

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(400);
  });

  it("POST /orders returns 503 when paper engine unavailable", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);
    // Don't inject services

    const route = routes.get("/api/v1/finance/orders");
    const { req } = createPostReq({
      symbol: "BTC/USDT",
      side: "buy",
      quantity: 0.1,
      currentPrice: 100,
    });

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(503);
  });

  it("POST /orders returns 202 when risk tier is confirm", async () => {
    // maxAutoTradeUsd=220, confirmThresholdUsd=900
    // Order value between $220 and $900 → confirm tier → 202
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/orders");
    const { req } = createPostReq({
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      quantity: 0.1,
      currentPrice: 5000, // 0.1 * 5000 = $500, above auto ($220) but below confirm ($900)
    });

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(202);
    const data = JSON.parse(output.body);
    expect(data.status).toBe("pending_approval");
    expect(data.eventId).toBeDefined();
  });

  // ── Orders Cancel ──

  it("POST /orders/cancel records cancellation event", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/orders/cancel");
    const { req } = createPostReq({ orderId: "o-123" });

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    expect(JSON.parse(output.body).status).toBe("cancelled");
  });

  it("POST /orders/cancel returns 400 on missing orderId", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/orders/cancel");
    const { req } = createPostReq({});

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(400);
  });

  // ── Positions Close ──

  it("POST /positions/close closes an open position", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/positions/close");
    const { req } = createPostReq({ symbol: "BTC/USDT" });

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.status).toBe("closed");
    expect(data.order.side).toBe("sell"); // close long → sell
  });

  it("POST /positions/close returns 404 for missing position", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/positions/close");
    const { req } = createPostReq({ symbol: "NONEXIST/USDT" });

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(404);
  });

  // ── Alerts CRUD ──

  it("GET /alerts returns empty list when alert engine unavailable", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/alerts");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const data = JSON.parse(recorder.read().body);
    expect(data.alerts).toEqual([]);
  });

  it("POST /alerts/create creates an alert and POST /alerts/remove removes it", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    // Create alert
    const createRoute = routes.get("/api/v1/finance/alerts/create");
    const { req: createReq } = createPostReq({
      kind: "price_above",
      symbol: "BTC/USDT",
      price: 70000,
      message: "BTC breakout",
    });
    const createRec = createResponseRecorder();
    (createRec.res as Record<string, unknown>).write = () => true;
    await createRoute?.(createReq, createRec.res);

    expect(createRec.read().statusCode).toBe(201);
    const created = JSON.parse(createRec.read().body);
    expect(created.id).toBeDefined();

    // List alerts
    const listRoute = routes.get("/api/v1/finance/alerts");
    const listRec = createResponseRecorder();
    (listRec.res as Record<string, unknown>).write = () => true;
    await listRoute?.({}, listRec.res);
    const listed = JSON.parse(listRec.read().body);
    expect(listed.alerts).toHaveLength(1);

    // Remove alert
    const removeRoute = routes.get("/api/v1/finance/alerts/remove");
    const { req: removeReq } = createPostReq({ id: created.id });
    const removeRec = createResponseRecorder();
    (removeRec.res as Record<string, unknown>).write = () => true;
    await removeRoute?.(removeReq, removeRec.res);

    expect(removeRec.read().statusCode).toBe(200);
    expect(JSON.parse(removeRec.read().body).status).toBe("removed");
  });

  it("POST /alerts/create returns 400 on missing kind", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/alerts/create");
    const { req } = createPostReq({ symbol: "BTC/USDT" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(400);
  });

  // ── Strategies ──

  it("GET /strategies returns strategy list", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const data = JSON.parse(recorder.read().body);
    expect(data.strategies).toHaveLength(1);
    expect(data.strategies[0].name).toBe("SMA Crossover");
  });

  it("POST /strategies/pause pauses a strategy", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies/pause");
    const { req } = createPostReq({ id: "sma-1" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    expect(JSON.parse(output.body).status).toBe("paused");

    const registry = services.get("fin-strategy-registry") as {
      updateStatus: ReturnType<typeof vi.fn>;
    };
    expect(registry.updateStatus).toHaveBeenCalledWith("sma-1", "paused");
  });

  it("POST /strategies/pause returns 404 for unknown strategy", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies/pause");
    const { req } = createPostReq({ id: "nonexist" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(404);
  });

  it("POST /strategies/kill kills a strategy", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies/kill");
    const { req } = createPostReq({ id: "sma-1" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    expect(JSON.parse(output.body).status).toBe("killed");

    const registry = services.get("fin-strategy-registry") as {
      updateLevel: ReturnType<typeof vi.fn>;
    };
    expect(registry.updateLevel).toHaveBeenCalledWith("sma-1", "KILLED");
  });

  it("POST /strategies/promote promotes a strategy to next level", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies/promote");
    const { req } = createPostReq({ id: "sma-1" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.status).toBe("promoted");
    expect(data.from).toBe("L2_PAPER");
    expect(data.to).toBe("L3_LIVE");
  });

  // ── Pause All ──

  it("POST /strategies/pause-all pauses all active strategies", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/strategies/pause-all");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.status).toBe("paused_all");
    expect(typeof data.count).toBe("number");
    expect(data.count).toBeGreaterThanOrEqual(0);
  });

  it("POST /strategies/pause-all returns 503 without registry", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/strategies/pause-all");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(503);
  });

  // ── Backtest All ──

  it("POST /strategies/backtest-all returns 503 without backtest engine", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);
    // Registry is available but backtest engine is not

    const route = routes.get("/api/v1/finance/strategies/backtest-all");
    const { req } = createPostReq({});
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(503);
    const data = JSON.parse(output.body);
    expect(data.error).toContain("not available");
  });

  // ── AI Chat ──

  it("POST /ai/chat returns fallback when agent not configured", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/ai/chat");
    const { req } = createPostReq({ message: "BTC 怎么样?", page: "overview" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.role).toBe("assistant");
    expect(data.fallback).toBe(true);
    expect(data.reply).toContain("BTC 怎么样?");
  });

  it("POST /ai/chat returns 400 without message", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/ai/chat");
    const { req } = createPostReq({});
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(400);
    const data = JSON.parse(output.body);
    expect(data.error).toContain("Missing message");
  });

  // ── Emergency Stop ──

  it("POST /emergency-stop disables trading and pauses strategies", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    const route = routes.get("/api/v1/finance/emergency-stop");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.status).toBe("stopped");
    expect(data.tradingDisabled).toBe(true);
    expect(data.strategiesPaused).toContain("sma-1");
  });

  // ── Agent Events ──

  it("GET /events returns event list with pending count", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/events");
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);

    const data = JSON.parse(recorder.read().body);
    expect(data).toHaveProperty("events");
    expect(data).toHaveProperty("pendingCount");
    expect(Array.isArray(data.events)).toBe(true);
  });

  it("GET /events/stream sends initial events and notifies on new events", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/events/stream");
    expect(route).toBeDefined();

    const stream = createStreamRecorder();
    const { req, disconnect } = createMockReq();
    await route?.(req, stream.res);

    // Should have initial payload
    const output = stream.read();
    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("text/event-stream");
    expect(output.chunks.length).toBeGreaterThanOrEqual(1);

    // Parse initial payload
    const initial = JSON.parse(output.chunks[0]!.replace("data: ", "").trim());
    expect(initial).toHaveProperty("events");
    expect(initial).toHaveProperty("pendingCount");

    // Trigger a new event (via emergency stop) to check subscriber notification
    const stopRoute = routes.get("/api/v1/finance/emergency-stop");
    const stopRec = createResponseRecorder();
    (stopRec.res as Record<string, unknown>).write = () => true;
    await stopRoute?.({}, stopRec.res);

    // Should have received the new event via SSE
    expect(stream.read().chunks.length).toBeGreaterThan(1);
    const newEventChunk = stream.read().chunks[stream.read().chunks.length - 1]!;
    const newPayload = JSON.parse(newEventChunk.replace("data: ", "").trim());
    expect(newPayload.type).toBe("new_event");
    expect(newPayload.event.type).toBe("emergency_stop");

    // Disconnect should clean up
    disconnect();
  });

  // ── Approval Flow ──

  it("POST /events/approve approves a pending event", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    // First, create a pending event by placing a large order
    // The risk config has maxAutoTradeUsd=220, confirmThresholdUsd=900
    // So an order of $500 (between 220 and 900) should trigger confirm
    const orderRoute = routes.get("/api/v1/finance/orders");
    const { req: orderReq } = createPostReq({
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      quantity: 0.2,
      currentPrice: 2500, // 0.2 * 2500 = $500
    });
    const orderRec = createResponseRecorder();
    (orderRec.res as Record<string, unknown>).write = () => true;
    await orderRoute?.(orderReq, orderRec.res);

    expect(orderRec.read().statusCode).toBe(202);
    const orderData = JSON.parse(orderRec.read().body);
    expect(orderData.status).toBe("pending_approval");
    const eventId = orderData.eventId;

    // Approve the event
    const approveRoute = routes.get("/api/v1/finance/events/approve");
    const { req: approveReq } = createPostReq({ id: eventId, action: "approve" });
    const approveRec = createResponseRecorder();
    (approveRec.res as Record<string, unknown>).write = () => true;
    await approveRoute?.(approveReq, approveRec.res);

    expect(approveRec.read().statusCode).toBe(200);
    const approveData = JSON.parse(approveRec.read().body);
    expect(approveData.status).toBe("approved");
    expect(approveData.event.actionParams).toBeDefined();
    expect(approveData.event.actionParams.symbol).toBe("ETH/USDT");
  });

  it("POST /events/approve rejects a pending event", async () => {
    const { api, services, routes } = createFakeApi();
    plugin.register(api);
    injectFullMockServices(services);

    // Create a pending event
    const orderRoute = routes.get("/api/v1/finance/orders");
    const { req: orderReq } = createPostReq({
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      quantity: 0.2,
      currentPrice: 2500,
    });
    const orderRec = createResponseRecorder();
    (orderRec.res as Record<string, unknown>).write = () => true;
    await orderRoute?.(orderReq, orderRec.res);

    const eventId = JSON.parse(orderRec.read().body).eventId;

    // Reject
    const approveRoute = routes.get("/api/v1/finance/events/approve");
    const { req: rejectReq } = createPostReq({
      id: eventId,
      action: "reject",
      reason: "Too risky",
    });
    const rejectRec = createResponseRecorder();
    (rejectRec.res as Record<string, unknown>).write = () => true;
    await approveRoute?.(rejectReq, rejectRec.res);

    expect(rejectRec.read().statusCode).toBe(200);
    expect(JSON.parse(rejectRec.read().body).status).toBe("rejected");
  });

  it("POST /events/approve returns 404 for non-existent event", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/events/approve");
    const { req } = createPostReq({ id: "nonexistent" });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    expect(recorder.read().statusCode).toBe(404);
  });

  // ── Risk Evaluate ──

  it("POST /risk/evaluate returns risk tier", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/risk/evaluate");
    const { req } = createPostReq({
      symbol: "BTC/USDT",
      side: "buy",
      amount: 0.01,
      estimatedValueUsd: 50, // Below maxAutoTradeUsd (220)
    });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const output = recorder.read();
    expect(output.statusCode).toBe(200);
    const data = JSON.parse(output.body);
    expect(data.tier).toBe("auto");
  });

  it("POST /risk/evaluate returns confirm tier for medium value", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/api/v1/finance/risk/evaluate");
    const { req } = createPostReq({
      symbol: "BTC/USDT",
      side: "buy",
      amount: 1,
      estimatedValueUsd: 500, // Between maxAutoTradeUsd (220) and confirmThresholdUsd (900)
    });
    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.(req, recorder.res);

    const data = JSON.parse(recorder.read().body);
    expect(data.tier).toBe("confirm");
  });

  // ── Command Center Dashboard Tests ──

  it("registers /dashboard/command-center route", () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    expect(routes.has("/dashboard/command-center")).toBe(true);
    expect(routes.has("/api/v1/finance/command-center")).toBe(true);
  });

  it("GET /api/v1/finance/command-center returns aggregated data", async () => {
    const { api, routes, services } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    const route = routes.get("/api/v1/finance/command-center");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(output.body);
    // Must have trading, events, alerts, and risk sections
    expect(payload).toHaveProperty("trading");
    expect(payload).toHaveProperty("events");
    expect(payload).toHaveProperty("alerts");
    expect(payload).toHaveProperty("risk");

    // Trading section has the standard structure
    expect(payload.trading).toHaveProperty("summary");
    expect(payload.trading).toHaveProperty("positions");
    expect(payload.trading).toHaveProperty("strategies");

    // Events section has events array and pendingCount
    expect(payload.events).toHaveProperty("events");
    expect(payload.events).toHaveProperty("pendingCount");
    expect(typeof payload.events.pendingCount).toBe("number");

    // Risk section has config fields
    expect(payload.risk).toMatchObject({
      enabled: true,
      maxAutoTradeUsd: 220,
      confirmThresholdUsd: 900,
      maxDailyLossUsd: 1800,
    });
  });

  it("/dashboard/command-center redirects to trading-desk", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/dashboard/command-center");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(302);
    expect(output.headers["Location"]).toBe("/dashboard/trading-desk");
  });

  it("GET /api/v1/finance/command-center returns events with pendingCount", async () => {
    const { api, routes, services } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    // Add a pending event via orders endpoint (triggers confirm tier)
    const orderRoute = routes.get("/api/v1/finance/orders");
    const { req: orderReq } = createPostReq({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 5,
      currentPrice: 100, // 5 * 100 = 500 > maxAutoTradeUsd(220), < confirmThresholdUsd(900)
    });
    const orderRecorder = createResponseRecorder();
    (orderRecorder.res as Record<string, unknown>).write = () => true;
    await orderRoute?.(orderReq, orderRecorder.res);
    expect(orderRecorder.read().statusCode).toBe(202);

    // Now check command center data includes the pending event
    const ccRoute = routes.get("/api/v1/finance/command-center");
    const ccRecorder = createResponseRecorder();
    (ccRecorder.res as Record<string, unknown>).write = () => true;
    await ccRoute?.({}, ccRecorder.res);
    const ccData = JSON.parse(ccRecorder.read().body);

    expect(ccData.events.pendingCount).toBeGreaterThanOrEqual(1);
    expect(ccData.events.events.length).toBeGreaterThanOrEqual(1);
    expect(
      ccData.events.events.some((e: Record<string, unknown>) => e.type === "trade_pending"),
    ).toBe(true);
  });

  // ── Mission Control Dashboard ──

  it("registers /dashboard/mission-control route", () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    expect(routes.has("/dashboard/mission-control")).toBe(true);
    expect(routes.has("/api/v1/finance/mission-control")).toBe(true);
  });

  it("GET /api/v1/finance/mission-control returns aggregated data with fund section", async () => {
    const { api, routes, services } = createFakeApi();
    plugin.register(api);
    injectMockTradingServices(services);

    const route = routes.get("/api/v1/finance/mission-control");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    (recorder.res as Record<string, unknown>).write = () => true;
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(200);
    expect(output.headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(output.body);
    // Must have trading, events, alerts, risk, and fund sections
    expect(payload).toHaveProperty("trading");
    expect(payload).toHaveProperty("events");
    expect(payload).toHaveProperty("alerts");
    expect(payload).toHaveProperty("risk");
    expect(payload).toHaveProperty("fund");

    // Trading section has the standard structure
    expect(payload.trading).toHaveProperty("summary");
    expect(payload.trading).toHaveProperty("positions");
    expect(payload.trading).toHaveProperty("strategies");

    // Fund section has allocations and totalCapital
    expect(payload.fund).toHaveProperty("allocations");
    expect(payload.fund).toHaveProperty("totalCapital");
  });

  it("/dashboard/mission-control redirects to overview", async () => {
    const { api, routes } = createFakeApi();
    plugin.register(api);

    const route = routes.get("/dashboard/mission-control");
    expect(route).toBeDefined();

    const recorder = createResponseRecorder();
    await route?.({}, recorder.res);
    const output = recorder.read();

    expect(output.statusCode).toBe(302);
    expect(output.headers["Location"]).toBe("/dashboard/overview");
  });
});
