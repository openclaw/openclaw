import { describe, it, expect, vi, beforeEach } from "vitest";
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

function makeDeps(serviceOverrides?: Record<string, unknown>): RouteHandlerDeps {
  const services = new Map<string, unknown>();
  if (serviceOverrides) {
    for (const [k, v] of Object.entries(serviceOverrides)) {
      services.set(k, v);
    }
  }
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
  };
}

describe("OHLCV route", () => {
  let routes: Map<string, RouteEntry>;
  let mockGetOHLCV: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetOHLCV = vi.fn().mockResolvedValue([
      { timestamp: 1700000000000, open: 100, high: 105, low: 98, close: 103, volume: 1000 },
      { timestamp: 1700003600000, open: 103, high: 110, low: 101, close: 108, volume: 1200 },
    ]);
    const deps = makeDeps({ "fin-data-provider": { getOHLCV: mockGetOHLCV } });
    routes = collectRoutes(deps);
  });

  it("should return candles for a valid symbol", async () => {
    const handler = routes.get("/api/v1/finance/ohlcv")!.handler;
    const req = makeReq("/api/v1/finance/ohlcv?symbol=BTC%2FUSDT&timeframe=1h&limit=100");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.symbol).toBe("BTC/USDT");
    expect(body.market).toBe("crypto");
    expect(body.timeframe).toBe("1h");
    expect(body.candles).toHaveLength(2);
    expect(mockGetOHLCV).toHaveBeenCalledWith({
      symbol: "BTC/USDT",
      market: "crypto",
      timeframe: "1h",
      limit: 100,
    });
  });

  it("should return 400 when symbol is missing", async () => {
    const handler = routes.get("/api/v1/finance/ohlcv")!.handler;
    const req = makeReq("/api/v1/finance/ohlcv?timeframe=1h");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toContain("symbol");
  });

  it("should return 503 when data provider is unavailable", async () => {
    const deps = makeDeps(); // no fin-data-provider
    const noProviderRoutes = collectRoutes(deps);
    const handler = noProviderRoutes.get("/api/v1/finance/ohlcv")!.handler;
    const req = makeReq("/api/v1/finance/ohlcv?symbol=ETH%2FUSDT");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.error).toContain("not available");
  });

  it("should use default params when not specified", async () => {
    const handler = routes.get("/api/v1/finance/ohlcv")!.handler;
    const req = makeReq("/api/v1/finance/ohlcv?symbol=SOL%2FUSDT");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockGetOHLCV).toHaveBeenCalledWith({
      symbol: "SOL/USDT",
      market: "crypto",
      timeframe: "1h",
      limit: 300,
    });
    const body = JSON.parse(res._body);
    expect(body.market).toBe("crypto");
    expect(body.timeframe).toBe("1h");
  });

  it("should accept custom market, timeframe, and limit params", async () => {
    const handler = routes.get("/api/v1/finance/ohlcv")!.handler;
    const req = makeReq("/api/v1/finance/ohlcv?symbol=AAPL&market=equity&timeframe=1d&limit=50");
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockGetOHLCV).toHaveBeenCalledWith({
      symbol: "AAPL",
      market: "equity",
      timeframe: "1d",
      limit: 50,
    });
    const body = JSON.parse(res._body);
    expect(body.market).toBe("equity");
    expect(body.timeframe).toBe("1d");
  });
});
