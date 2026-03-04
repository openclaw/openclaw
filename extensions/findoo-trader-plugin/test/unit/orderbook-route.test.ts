import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import { registerHttpRoutes } from "../../src/core/route-handlers.js";
import type { RouteHandlerDeps } from "../../src/core/route-handlers.js";
import type { HttpRes } from "../../src/types-http.js";

type RouteEntry = { path: string; handler: (req: unknown, res: HttpRes) => Promise<void> };

function makeRes(): HttpRes & { _status: number; _body: string; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: "",
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      res._status = status;
      Object.assign(res._headers, headers);
    },
    write(chunk: string) {
      res._body += chunk;
      return true;
    },
    end(body?: string) {
      if (body) res._body += body;
    },
  };
  return res;
}

function makeReq(url: string) {
  return { url, on: vi.fn(), method: "GET" };
}

function collectRoutes(deps: RouteHandlerDeps): Map<string, RouteEntry> {
  const routes = new Map<string, RouteEntry>();
  const api = {
    ...deps.api,
    registerHttpRoute(entry: RouteEntry) {
      routes.set(entry.path, entry);
    },
  };
  registerHttpRoutes({ ...deps, api } as unknown as RouteHandlerDeps);
  return routes;
}

function makeDeps(registryOverride?: Partial<ExchangeRegistry>): RouteHandlerDeps {
  const services = new Map<string, unknown>();
  return {
    api: { registerHttpRoute: vi.fn() } as unknown as RouteHandlerDeps["api"],
    gatherDeps: {} as RouteHandlerDeps["gatherDeps"],
    eventStore: {
      addEvent: vi.fn(),
      listEvents: vi.fn(() => []),
      pendingCount: vi.fn(() => 0),
      getEvent: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
    } as unknown as RouteHandlerDeps["eventStore"],
    healthStore: { listAll: vi.fn(() => []) } as unknown as RouteHandlerDeps["healthStore"],
    riskController: {
      evaluate: vi.fn(),
      updateConfig: vi.fn(),
    } as unknown as RouteHandlerDeps["riskController"],
    runtime: { services },
    templates: {} as RouteHandlerDeps["templates"],
    registry: registryOverride as ExchangeRegistry | undefined,
  };
}

const mockOrderBook = {
  bids: [
    [50000, 1.5],
    [49900, 2.0],
  ] as [number, number][],
  asks: [
    [50100, 0.8],
    [50200, 1.2],
  ] as [number, number][],
  timestamp: 1700000000000,
};

describe("OrderBook route", () => {
  let routes: Map<string, RouteEntry>;
  let mockFetchOrderBook: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetchOrderBook = vi.fn().mockResolvedValue(mockOrderBook);
    const registry = {
      listExchanges: vi.fn(() => [{ id: "binance", exchange: "binance", testnet: false }]),
      getInstance: vi.fn().mockResolvedValue({ fetchOrderBook: mockFetchOrderBook }),
    };
    const deps = makeDeps(registry as unknown as ExchangeRegistry);
    routes = collectRoutes(deps);
  });

  it("should return order book for a valid symbol", async () => {
    const handler = routes.get("/api/v1/finance/orderbook")!.handler;
    const req = makeReq("/api/v1/finance/orderbook?symbol=BTC%2FUSDT");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.symbol).toBe("BTC/USDT");
    expect(body.bids).toEqual(mockOrderBook.bids);
    expect(body.asks).toEqual(mockOrderBook.asks);
    expect(body.timestamp).toBe(1700000000000);
  });

  it("should return 404 when no exchanges are configured (no registry)", async () => {
    const deps = makeDeps(undefined);
    const noRegistryRoutes = collectRoutes(deps);
    const handler = noRegistryRoutes.get("/api/v1/finance/orderbook")!.handler;
    const req = makeReq("/api/v1/finance/orderbook?symbol=BTC%2FUSDT");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toContain("No exchanges configured");
  });

  it("should return 404 when exchange not found", async () => {
    const registry = {
      listExchanges: vi.fn(() => [{ id: "binance", exchange: "binance", testnet: false }]),
      getInstance: vi.fn().mockRejectedValue(new Error("not configured")),
    };
    const deps = makeDeps(registry as unknown as ExchangeRegistry);
    const errRoutes = collectRoutes(deps);
    const handler = errRoutes.get("/api/v1/finance/orderbook")!.handler;
    const req = makeReq("/api/v1/finance/orderbook?symbol=BTC%2FUSDT&exchangeId=kraken");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toContain("kraken");
  });

  it("should use default limit of 20", async () => {
    const handler = routes.get("/api/v1/finance/orderbook")!.handler;
    const req = makeReq("/api/v1/finance/orderbook?symbol=ETH%2FUSDT");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockFetchOrderBook).toHaveBeenCalledWith("ETH/USDT", 20);
  });

  it("should accept custom limit parameter", async () => {
    const handler = routes.get("/api/v1/finance/orderbook")!.handler;
    const req = makeReq("/api/v1/finance/orderbook?symbol=ETH%2FUSDT&limit=10");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockFetchOrderBook).toHaveBeenCalledWith("ETH/USDT", 10);
  });
});
