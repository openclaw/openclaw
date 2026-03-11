import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { BacktestEngine } from "./src/backtest-engine.js";
import { StrategyRegistry } from "./src/strategy-registry.js";

let mockedHomeDir = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir || actual.homedir(),
  };
});

function createFakeApi(stateDir: string) {
  const tools = new Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >();
  const services = new Map<string, unknown>();
  const api = {
    id: "fin-strategy-engine",
    name: "Strategy Engine",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test", services },
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
    resolvePath: (p: string) => join(stateDir, p),
    on() {},
  } as unknown as OpenClawPluginApi;
  return { api, tools, services };
}

function parseResult(result: unknown): unknown {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

describe("fin-strategy-engine plugin", () => {
  let tempDir: string;
  let tools: Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >;
  let services: Map<string, unknown>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fin-strategy-engine-test-"));
    mockedHomeDir = tempDir;
    const fake = createFakeApi(tempDir);
    tools = fake.tools;
    services = fake.services;
    plugin.register(fake.api);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all 4 tools", () => {
    expect(tools.has("fin_strategy_create")).toBe(true);
    expect(tools.has("fin_strategy_list")).toBe(true);
    expect(tools.has("fin_backtest_run")).toBe(true);
    expect(tools.has("fin_backtest_result")).toBe(true);
  });

  it("registers both services", () => {
    expect(services.has("fin-strategy-registry")).toBe(true);
    expect(services.has("fin-backtest-engine")).toBe(true);
    expect(services.get("fin-strategy-registry")).toBeInstanceOf(StrategyRegistry);
    expect(services.get("fin-backtest-engine")).toBeInstanceOf(BacktestEngine);
  });

  describe("fin_strategy_create", () => {
    it("creates an SMA crossover strategy", async () => {
      const tool = tools.get("fin_strategy_create")!;
      const result = parseResult(
        await tool.execute("call-1", {
          name: "My SMA Strategy",
          type: "sma-crossover",
          parameters: { fastPeriod: 5, slowPeriod: 20 },
          symbols: ["ETH/USDT"],
        }),
      ) as Record<string, unknown>;

      expect(result.created).toBe(true);
      expect(result.name).toBe("My SMA Strategy");
      expect(result.level).toBe("L0_INCUBATE");
    });

    it("creates an RSI mean reversion strategy", async () => {
      const tool = tools.get("fin_strategy_create")!;
      const result = parseResult(
        await tool.execute("call-2", {
          name: "My RSI Strategy",
          type: "rsi-mean-reversion",
          parameters: { period: 7, oversold: 25, overbought: 75 },
        }),
      ) as Record<string, unknown>;

      expect(result.created).toBe(true);
      expect(result.name).toBe("My RSI Strategy");
    });

    it("creates a Bollinger Bands strategy", async () => {
      const tool = tools.get("fin_strategy_create")!;
      const result = parseResult(
        await tool.execute("call-bb", {
          name: "My BB Strategy",
          type: "bollinger-bands",
          parameters: { period: 15, stdDev: 1.5 },
        }),
      ) as Record<string, unknown>;

      expect(result.created).toBe(true);
      expect(result.name).toBe("My BB Strategy");
      expect(result.level).toBe("L0_INCUBATE");
    });

    it("creates a MACD Divergence strategy", async () => {
      const tool = tools.get("fin_strategy_create")!;
      const result = parseResult(
        await tool.execute("call-macd", {
          name: "My MACD Strategy",
          type: "macd-divergence",
          parameters: { fastPeriod: 8, slowPeriod: 21, signalPeriod: 5 },
        }),
      ) as Record<string, unknown>;

      expect(result.created).toBe(true);
      expect(result.name).toBe("My MACD Strategy");
      expect(result.level).toBe("L0_INCUBATE");
    });

    it("rejects unknown strategy type", async () => {
      const tool = tools.get("fin_strategy_create")!;
      const result = parseResult(
        await tool.execute("call-3", { name: "Bad", type: "custom" }),
      ) as Record<string, unknown>;

      expect(result.error).toBeDefined();
    });
  });

  describe("fin_strategy_list", () => {
    it("returns empty list initially", async () => {
      const tool = tools.get("fin_strategy_list")!;
      const result = parseResult(await tool.execute("call-4", {})) as Record<string, unknown>;

      expect(result.total).toBe(0);
      expect(result.strategies).toEqual([]);
    });

    it("lists created strategies", async () => {
      const createTool = tools.get("fin_strategy_create")!;
      await createTool.execute("c1", { name: "S1", type: "sma-crossover" });
      await createTool.execute("c2", { name: "S2", type: "rsi-mean-reversion" });

      const listTool = tools.get("fin_strategy_list")!;
      const result = parseResult(await listTool.execute("call-5", {})) as Record<string, unknown>;

      expect(result.total).toBe(2);
    });
  });

  describe("fin_backtest_result", () => {
    it("returns error for nonexistent strategy", async () => {
      const tool = tools.get("fin_backtest_result")!;
      const result = parseResult(
        await tool.execute("call-6", { strategyId: "nonexistent" }),
      ) as Record<string, unknown>;

      expect(result.error).toContain("not found");
    });

    it("returns error when no backtest has been run", async () => {
      const createTool = tools.get("fin_strategy_create")!;
      const created = parseResult(
        await createTool.execute("c3", { name: "S3", type: "sma-crossover" }),
      ) as Record<string, unknown>;

      const tool = tools.get("fin_backtest_result")!;
      const result = parseResult(
        await tool.execute("call-7", { strategyId: created.id as string }),
      ) as Record<string, unknown>;

      expect(result.error).toContain("No backtest");
    });
  });

  describe("fin_backtest_run", () => {
    it("returns error when data provider is missing", async () => {
      const createTool = tools.get("fin_strategy_create")!;
      const created = parseResult(
        await createTool.execute("c4", { name: "S4", type: "sma-crossover" }),
      ) as Record<string, unknown>;

      const tool = tools.get("fin_backtest_run")!;
      const result = parseResult(
        await tool.execute("call-8", { strategyId: created.id as string }),
      ) as Record<string, unknown>;

      expect(result.error).toContain("Data provider");
    });

    it("uses object-based data provider contract", async () => {
      const createTool = tools.get("fin_strategy_create")!;
      const created = parseResult(
        await createTool.execute("c5", { name: "S5", type: "sma-crossover" }),
      ) as Record<string, unknown>;

      const getOHLCV = vi.fn(
        async (params: { symbol: string; market: string; timeframe: string; limit?: number }) => {
          const bars = params.limit ?? 365;
          return Array.from({ length: bars }, (_, index) => {
            const open = 100 + index * 0.1;
            return {
              timestamp: Date.UTC(2026, 0, 1) + index * 86_400_000,
              open,
              high: open + 1,
              low: open - 1,
              close: open + Math.sin(index / 8),
              volume: 1000 + index,
            };
          });
        },
      );
      services.set("fin-data-provider", { getOHLCV });

      const tool = tools.get("fin_backtest_run")!;
      const result = parseResult(
        await tool.execute("call-9", { strategyId: created.id as string }),
      ) as Record<string, unknown>;

      expect(result.error).toBeUndefined();
      expect(getOHLCV).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: "BTC/USDT",
          market: "crypto",
          timeframe: "1d",
          limit: 365,
        }),
      );
    });
  });
});
