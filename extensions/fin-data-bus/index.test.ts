import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import finDataBusPlugin from "./index.js";

// Mock yahoo-finance2 so the dynamic import in register() gets a controllable stub
vi.mock("yahoo-finance2", () => ({
  default: {
    chart: vi.fn().mockResolvedValue({ quotes: [] }),
    quote: vi.fn().mockResolvedValue({ regularMarketPrice: 0 }),
  },
}));

// --- Mock exchange instance ---
function createMockExchange() {
  return {
    fetchTicker: vi.fn(),
    fetchOHLCV: vi.fn(),
  };
}

// --- Mock registry ---
function createMockRegistry(
  exchanges: Array<{ id: string; exchange: string; testnet: boolean }> = [],
) {
  const instances = new Map<string, ReturnType<typeof createMockExchange>>();
  for (const ex of exchanges) {
    instances.set(ex.id, createMockExchange());
  }
  return {
    listExchanges: vi.fn(() => exchanges),
    getInstance: vi.fn(async (id: string) => {
      const inst = instances.get(id);
      if (!inst) throw new Error(`Exchange "${id}" not configured.`);
      return inst;
    }),
    _instances: instances,
  };
}

// --- Fake plugin API ---
function createFakeApi(
  registry: ReturnType<typeof createMockRegistry> | null,
  tempDir: string,
): {
  api: OpenClawPluginApi;
  tools: Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >;
  services: Map<string, unknown>;
} {
  const tools = new Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >();
  const services = new Map<string, unknown>();
  if (registry) {
    services.set("fin-exchange-registry", registry);
  }

  const api = {
    id: "fin-data-bus",
    name: "Data Bus",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {
      version: "test",
      services,
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(tool: {
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    }) {
      tools.set(tool.name, tool);
    },
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService(svc: { id: string; instance: unknown }) {
      services.set(svc.id, svc.instance);
    },
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => join(tempDir, p),
    on() {},
  } as unknown as OpenClawPluginApi;

  return { api, tools, services };
}

function parseResult(result: unknown): unknown {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

describe("fin-data-bus plugin", () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let tools: Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >;
  let services: Map<string, unknown>;
  let mockExchange: ReturnType<typeof createMockExchange>;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "fin-data-bus-test-"));
    registry = createMockRegistry([{ id: "test-binance", exchange: "binance", testnet: false }]);
    mockExchange = registry._instances.get("test-binance")!;
    const result = createFakeApi(registry, tempDir);
    tools = result.tools;
    services = result.services;
    await finDataBusPlugin.register(result.api);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all three tools", () => {
    expect(tools.has("fin_data_ohlcv")).toBe(true);
    expect(tools.has("fin_data_regime")).toBe(true);
    expect(tools.has("fin_data_markets")).toBe(true);
  });

  it("registers services", () => {
    expect(services.has("fin-data-provider")).toBe(true);
    expect(services.has("fin-regime-detector")).toBe(true);
  });

  describe("fin_data_ohlcv", () => {
    it("returns OHLCV data from exchange", async () => {
      mockExchange.fetchOHLCV.mockResolvedValue([
        [1708819200000, 67000, 67800, 66900, 67500, 1500],
        [1708822800000, 67500, 68000, 67200, 67800, 1200],
      ]);

      const tool = tools.get("fin_data_ohlcv")!;
      const result = parseResult(await tool.execute("call-1", { symbol: "BTC/USDT" })) as Record<
        string,
        unknown
      >;

      expect(result.symbol).toBe("BTC/USDT");
      expect(result.market).toBe("crypto");
      expect(result.timeframe).toBe("1h");
      expect(result.count).toBe(2);
      expect((result.candles as unknown[]).length).toBe(2);
    });

    it("returns empty result for equity via Yahoo fallback", async () => {
      const tool = tools.get("fin_data_ohlcv")!;
      const result = parseResult(
        await tool.execute("call-2", { symbol: "AAPL", market: "equity" }),
      ) as Record<string, unknown>;

      // Yahoo mock returns empty quotes, so count is 0 (no error)
      expect(result.count).toBe(0);
      expect(result.symbol).toBe("AAPL");
      expect(result.market).toBe("equity");
    });

    it("returns error on exchange failure", async () => {
      mockExchange.fetchOHLCV.mockRejectedValue(new Error("Network timeout"));

      const tool = tools.get("fin_data_ohlcv")!;
      const result = parseResult(await tool.execute("call-3", { symbol: "BTC/USDT" })) as Record<
        string,
        unknown
      >;

      expect(result.error).toContain("Network timeout");
    });
  });

  describe("fin_data_regime", () => {
    it("returns regime classification", async () => {
      // Generate 300 rising candles to get "bull"
      const candles: Array<[number, number, number, number, number, number]> = [];
      let close = 100;
      for (let i = 0; i < 300; i++) {
        close = close * 1.005;
        candles.push([i * 3600000, close - 1, close + 1, close - 2, close, 1000]);
      }
      mockExchange.fetchOHLCV.mockResolvedValue(candles);

      const tool = tools.get("fin_data_regime")!;
      const result = parseResult(await tool.execute("call-4", { symbol: "BTC/USDT" })) as Record<
        string,
        unknown
      >;

      expect(result.symbol).toBe("BTC/USDT");
      expect(result.market).toBe("crypto");
      expect(result.timeframe).toBe("4h");
      expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(result.regime);
    });

    it("returns regime for equity via Yahoo fallback", async () => {
      // Yahoo mock returns empty quotes → regime detection on empty data
      const tool = tools.get("fin_data_regime")!;
      const result = parseResult(
        await tool.execute("call-5", { symbol: "AAPL", market: "equity" }),
      ) as Record<string, unknown>;

      expect(result.symbol).toBe("AAPL");
      expect(result.market).toBe("equity");
      // With empty data, regime detector returns a valid regime
      expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(result.regime);
    });
  });

  describe("fin_data_markets", () => {
    it("returns supported markets list", async () => {
      const tool = tools.get("fin_data_markets")!;
      const result = parseResult(await tool.execute("call-6", {})) as Record<string, unknown>;

      const markets = result.markets as Array<{ market: string; available: boolean }>;
      expect(markets).toHaveLength(3);

      const crypto = markets.find((m) => m.market === "crypto");
      expect(crypto?.available).toBe(true);

      const equity = markets.find((m) => m.market === "equity");
      expect(equity?.available).toBe(true);
    });
  });

  describe("error scenarios", () => {
    it("returns error when fin-core not loaded", async () => {
      const { api, tools: noRegistryTools } = createFakeApi(null, tempDir);
      await finDataBusPlugin.register(api);

      const tool = noRegistryTools.get("fin_data_ohlcv")!;
      const result = parseResult(
        await tool.execute("call-err-1", { symbol: "BTC/USDT" }),
      ) as Record<string, unknown>;

      expect(result.error).toContain("exchange registry unavailable");
    });

    it("returns error when no exchanges configured", async () => {
      const emptyRegistry = createMockRegistry([]);
      const { api, tools: emptyTools } = createFakeApi(emptyRegistry, tempDir);
      await finDataBusPlugin.register(api);

      const tool = emptyTools.get("fin_data_ohlcv")!;
      const result = parseResult(
        await tool.execute("call-err-2", { symbol: "BTC/USDT" }),
      ) as Record<string, unknown>;

      expect(result.error).toContain("No exchanges configured");
    });
  });
});
