/**
 * L3 — Gateway Bootstrap E2E
 *
 * Verifies findoo-datahub-plugin loads correctly in a gateway-like environment:
 *   1. Plugin registers all 13 tools
 *   2. Plugin registers both services (fin-data-provider, fin-regime-detector)
 *   3. Tools are callable and return well-formed responses
 *   4. Services are consumable by other extensions
 *   5. Config resolution works with various env var combinations
 *
 * No real gateway process — uses the same fake API pattern as integration tests
 * but validates the full plugin bootstrap contract.
 *
 * Run:
 *   npx vitest run extensions/findoo-datahub-plugin/test/e2e/l3-gateway-bootstrap.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import findooDatahubPlugin from "../../index.js";

const SKIP = process.env.DATAHUB_SKIP_LIVE === "1";
const DEV_KEY = "98ffa5c5-1ec6-4735-8e0c-715a5eca1a8d";

/* ---------- helpers ---------- */

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function createGatewayApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDef>();
  const services = new Map<string, unknown>();
  const logs: Array<{ level: string; msg: string }> = [];

  const api = {
    id: "findoo-datahub-plugin",
    name: "Findoo DataHub",
    source: "gateway",
    config: {},
    pluginConfig: {
      datahubApiKey: process.env.DATAHUB_API_KEY ?? process.env.DATAHUB_PASSWORD ?? DEV_KEY,
      ...pluginConfig,
    },
    runtime: { version: "test-gateway", services },
    logger: {
      info: (...args: unknown[]) => logs.push({ level: "info", msg: String(args[0]) }),
      warn: (...args: unknown[]) => logs.push({ level: "warn", msg: String(args[0]) }),
      error: (...args: unknown[]) => logs.push({ level: "error", msg: String(args[0]) }),
      debug: (...args: unknown[]) => logs.push({ level: "debug", msg: String(args[0]) }),
    },
    log: (level: string, msg: string) => logs.push({ level, msg }),
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService(svc: { id: string; instance: unknown }) {
      services.set(svc.id, svc.instance);
    },
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => {
      const full = join(stateDir, p);
      mkdirSync(join(full, ".."), { recursive: true });
      return full;
    },
    on: vi.fn(),
  };
  return { api: api as never, tools, services, logs };
}

function parseResult(result: unknown): Record<string, unknown> {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

/* ---------- tests ---------- */

describe.skipIf(SKIP)("L3 — Gateway Bootstrap E2E", { timeout: 120_000 }, () => {
  let tempDir: string;
  let tools: Map<string, ToolDef>;
  let services: Map<string, unknown>;
  let logs: Array<{ level: string; msg: string }>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "l3-gateway-"));
    const ctx = createGatewayApi(tempDir);
    tools = ctx.tools;
    services = ctx.services;
    logs = ctx.logs;
    // Simulate gateway calling plugin.register()
    await findooDatahubPlugin.register(ctx.api);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /* === Section 1: Plugin registration contract === */

  describe("1. Registration contract", () => {
    it("1.1 plugin has correct metadata", () => {
      expect(findooDatahubPlugin.id).toBe("findoo-datahub-plugin");
      expect(findooDatahubPlugin.name).toBe("Findoo DataHub");
      expect(findooDatahubPlugin.kind).toBe("financial");
    });

    it("1.2 registers exactly 13 tools", () => {
      expect(tools.size).toBe(13);
    });

    it("1.3 all 13 tool names match specification", () => {
      const expected = [
        "fin_stock",
        "fin_index",
        "fin_macro",
        "fin_derivatives",
        "fin_crypto",
        "fin_market",
        "fin_query",
        "fin_data_ohlcv",
        "fin_data_regime",
        "fin_ta",
        "fin_etf",
        "fin_data_markets",
        "fin_currency",
      ];
      for (const name of expected) {
        expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
      }
      // No extra tools
      for (const name of tools.keys()) {
        expect(expected.includes(name), `Unexpected tool: ${name}`).toBe(true);
      }
    });

    it("1.4 each tool has name, description, and execute function", () => {
      for (const [name, tool] of tools) {
        expect(typeof tool.name, `${name}.name`).toBe("string");
        expect(typeof tool.description, `${name}.description`).toBe("string");
        expect(tool.description!.length, `${name}.description length`).toBeGreaterThan(10);
        expect(typeof tool.execute, `${name}.execute`).toBe("function");
      }
    });

    it("1.5 registers both required services", () => {
      expect(services.has("fin-data-provider")).toBe(true);
      expect(services.has("fin-regime-detector")).toBe(true);
    });

    it("1.6 fin-data-provider service has required methods", () => {
      const provider = services.get("fin-data-provider") as Record<string, unknown>;
      expect(typeof provider.getOHLCV).toBe("function");
      expect(typeof provider.getTicker).toBe("function");
      expect(typeof provider.detectRegime).toBe("function");
      expect(typeof provider.getSupportedMarkets).toBe("function");
    });

    it("1.7 fin-regime-detector service has detect method", () => {
      const detector = services.get("fin-regime-detector") as Record<string, unknown>;
      expect(typeof detector.detect).toBe("function");
    });
  });

  /* === Section 2: Tool response format contract === */

  describe("2. Tool response format", () => {
    it("2.1 category tools return {success, endpoint, count, results}", async () => {
      const tool = tools.get("fin_stock")!;
      const raw = await tool.execute("fmt-1", {
        symbol: "600519.SH",
        endpoint: "price/historical",
        limit: 3,
      });
      const res = parseResult(raw);
      expect(res).toHaveProperty("success");
      expect(res).toHaveProperty("endpoint");
      expect(res).toHaveProperty("count");
      expect(res).toHaveProperty("results");
      expect(res.success).toBe(true);
      expect(typeof res.count).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    }, 30_000);

    it("2.2 fin_data_ohlcv returns {symbol, market, timeframe, count, candles}", async () => {
      const tool = tools.get("fin_data_ohlcv")!;
      const raw = await tool.execute("fmt-2", {
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 5,
      });
      const res = parseResult(raw);
      expect(res.symbol).toBe("600519.SH");
      expect(res.market).toBe("equity");
      expect(res.timeframe).toBe("1d");
      expect(typeof res.count).toBe("number");
      expect(Array.isArray(res.candles)).toBe(true);
      const candle = (res.candles as Array<Record<string, unknown>>)[0]!;
      expect(candle).toHaveProperty("timestamp");
      expect(candle).toHaveProperty("open");
      expect(candle).toHaveProperty("high");
      expect(candle).toHaveProperty("low");
      expect(candle).toHaveProperty("close");
      expect(candle).toHaveProperty("volume");
    }, 30_000);

    it("2.3 fin_data_regime returns {symbol, market, timeframe, regime}", async () => {
      const tool = tools.get("fin_data_regime")!;
      const raw = await tool.execute("fmt-3", {
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
      });
      const res = parseResult(raw);
      expect(res.symbol).toBe("600519.SH");
      expect(res.market).toBe("equity");
      expect(res.timeframe).toBe("1d");
      expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(res.regime);
    }, 30_000);

    it("2.4 fin_data_markets returns {datahub, markets, categories, endpoints}", async () => {
      const tool = tools.get("fin_data_markets")!;
      const raw = await tool.execute("fmt-4", {});
      const res = parseResult(raw);
      expect(res).toHaveProperty("connected");
      expect(res).toHaveProperty("markets");
      expect(res).toHaveProperty("categories");
      expect(res.endpoints).toBe(172);
    });

    it("2.5 error responses return {error: string}", async () => {
      const tool = tools.get("fin_query")!;
      const raw = await tool.execute("fmt-5", { path: "" });
      const res = parseResult(raw);
      expect(typeof res.error).toBe("string");
      expect(res.success).toBeUndefined();
    });
  });

  /* === Section 3: Config resolution === */

  describe("3. Config edge cases", () => {
    it("3.1 plugin warns when no API key configured", async () => {
      const tmpDir2 = mkdtempSync(join(tmpdir(), "l3-nokey-"));
      const saved = { ...process.env };
      delete process.env.DATAHUB_API_KEY;
      delete process.env.DATAHUB_PASSWORD;
      delete process.env.OPENFINCLAW_DATAHUB_PASSWORD;

      const ctx = createGatewayApi(tmpDir2, { datahubApiKey: undefined });
      // Clear the pluginConfig entirely so resolveConfig can't find a key
      (ctx.api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {};
      await findooDatahubPlugin.register(ctx.api);

      const errorLog = ctx.logs.find(
        (l) => l.level === "error" && l.msg.includes("API key is required"),
      );
      expect(errorLog).toBeDefined();

      // Restore
      Object.assign(process.env, saved);
      rmSync(tmpDir2, { recursive: true, force: true });
    });

    it("3.2 plugin still registers all tools even without API key", async () => {
      const tmpDir2 = mkdtempSync(join(tmpdir(), "l3-nokey2-"));
      const ctx = createGatewayApi(tmpDir2, { datahubApiKey: undefined });
      (ctx.api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {};
      await findooDatahubPlugin.register(ctx.api);
      expect(ctx.tools.size).toBe(13);
      expect(ctx.services.size).toBe(2);
      rmSync(tmpDir2, { recursive: true, force: true });
    });
  });

  /* === Section 4: Cross-extension service consumption === */

  describe("4. Cross-extension service consumption", () => {
    it("4.1 another extension can resolve fin-data-provider and call getOHLCV", async () => {
      // Simulate another extension calling the service
      const provider = services.get("fin-data-provider") as {
        getOHLCV: (p: {
          symbol: string;
          market: string;
          timeframe: string;
          limit: number;
        }) => Promise<Array<{ timestamp: number; close: number }>>;
      };

      const data = await provider.getOHLCV({
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 10,
      });
      expect(data.length).toBeGreaterThan(0);
      expect(typeof data[0]!.timestamp).toBe("number");
      expect(typeof data[0]!.close).toBe("number");
    }, 30_000);

    it("4.2 another extension can resolve fin-regime-detector and detect regime", async () => {
      const provider = services.get("fin-data-provider") as {
        getOHLCV: (p: {
          symbol: string;
          market: string;
          timeframe: string;
          limit: number;
        }) => Promise<
          Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>
        >;
      };
      const detector = services.get("fin-regime-detector") as {
        detect: (
          bars: Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>,
        ) => string;
      };

      const bars = await provider.getOHLCV({
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 300,
      });
      const regime = detector.detect(bars);
      expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(regime);
    }, 30_000);
  });
});
