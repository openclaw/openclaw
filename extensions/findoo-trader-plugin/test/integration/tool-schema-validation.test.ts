/**
 * AI tool schema validation tests — Phase C (F-5).
 * Calls tool.execute() directly, validates return JSON types.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OHLCV } from "../../src/shared/types.js";
import { BacktestEngine } from "../../src/strategy/backtest-engine.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../src/strategy/tools.js";

// --- helpers ---

function makeOHLCV(count: number, basePrice = 100, startTs = 1_700_000_000_000): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const close = basePrice + Math.sin(i / 5) * 10;
    bars.push({
      timestamp: startTs + i * 86_400_000,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

type ToolExecuteFn = (
  id: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

/** Capture tools registered via api.registerTool. */
function captureTools(serviceOverrides?: Map<string, unknown>) {
  const tools = new Map<string, ToolExecuteFn>();
  const api = {
    registerTool: vi.fn(
      (def: { name: string; execute: ToolExecuteFn }, opts: { names: string[] }) => {
        for (const name of opts.names) {
          tools.set(name, def.execute.bind(def));
        }
      },
    ),
    runtime: { services: serviceOverrides ?? new Map() },
  };
  return { api, tools };
}

function parseDetails(result: { details: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fin-tool-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Tool schema validation", () => {
  it("fin_strategy_create: returns { created, id, level }", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const { api, tools } = captureTools();

    registerStrategyTools(api as never, registry, engine, null, null);

    const execute = tools.get("fin_strategy_create")!;
    const result = await execute("test-id", {
      name: "Test SMA",
      type: "sma-crossover",
      parameters: { fastPeriod: 5, slowPeriod: 20 },
    });

    const payload = parseDetails(result);
    expect(payload.created).toBe(true);
    expect(typeof payload.id).toBe("string");
    expect(payload.level).toBe("L0_INCUBATE");
  });

  it("fin_strategy_list: returns { total: number, strategies: Array }", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const { api, tools } = captureTools();

    registerStrategyTools(api as never, registry, engine, null, null);

    // Create a strategy first
    const createFn = tools.get("fin_strategy_create")!;
    await createFn("test-id", { name: "List Test", type: "rsi-mean-reversion" });

    const listFn = tools.get("fin_strategy_list")!;
    const result = await listFn("test-id", {});
    const payload = parseDetails(result);

    expect(typeof payload.total).toBe("number");
    expect(payload.total).toBe(1);
    expect(Array.isArray(payload.strategies)).toBe(true);
  });

  it("fin_backtest_run: top-level fields are numbers (not strings)", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const ohlcvData = makeOHLCV(60);

    const services = new Map<string, unknown>();
    services.set("fin-data-provider", {
      getOHLCV: async () => ohlcvData,
    });
    const { api, tools } = captureTools(services);

    registerStrategyTools(api as never, registry, engine, null, null);

    // Create strategy
    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "BT Num Test",
      type: "sma-crossover",
      parameters: { fastPeriod: 3, slowPeriod: 10 },
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // Run backtest
    const btFn = tools.get("fin_backtest_run")!;
    const btResult = await btFn("test-id", { strategyId });
    const payload = parseDetails(btResult);

    // ⭐ Key assertion: numeric types
    expect(typeof payload.totalReturn).toBe("number");
    expect(typeof payload.sharpe).toBe("number");
    expect(typeof payload.sortino).toBe("number");
    expect(typeof payload.maxDrawdown).toBe("number");
    expect(typeof payload.winRate).toBe("number");
    expect(typeof payload.profitFactor).toBe("number");
    expect(typeof payload.totalTrades).toBe("number");
    expect(typeof payload.finalEquity).toBe("number");
    expect(typeof payload.initialCapital).toBe("number");
  });

  it("fin_backtest_run: formatted sub-object has strings", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const ohlcvData = makeOHLCV(60);

    const services = new Map<string, unknown>();
    services.set("fin-data-provider", { getOHLCV: async () => ohlcvData });
    const { api, tools } = captureTools(services);

    registerStrategyTools(api as never, registry, engine, null, null);

    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "Fmt Test",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    const btFn = tools.get("fin_backtest_run")!;
    const btResult = await btFn("test-id", { strategyId });
    const payload = parseDetails(btResult);

    const formatted = payload.formatted as Record<string, string>;
    expect(typeof formatted.totalReturn).toBe("string");
    expect(formatted.totalReturn).toContain("%");
    expect(typeof formatted.sharpe).toBe("string");
    expect(typeof formatted.maxDrawdown).toBe("string");
    expect(formatted.maxDrawdown).toContain("%");
    expect(typeof formatted.winRate).toBe("string");
    expect(typeof formatted.finalEquity).toBe("string");
  });

  it("fin_backtest_result consistency: run and result return equal values", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const ohlcvData = makeOHLCV(60);

    const services = new Map<string, unknown>();
    services.set("fin-data-provider", { getOHLCV: async () => ohlcvData });
    const { api, tools } = captureTools(services);

    registerStrategyTools(api as never, registry, engine, null, null);

    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "Consistency",
      type: "sma-crossover",
      parameters: { fastPeriod: 3, slowPeriod: 10 },
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    // Run backtest
    const btFn = tools.get("fin_backtest_run")!;
    const runPayload = parseDetails(await btFn("test-id", { strategyId }));

    // Get result
    const resultFn = tools.get("fin_backtest_result")!;
    const resultPayload = parseDetails(await resultFn("test-id", { strategyId }));

    // ⭐ Key: both return the same numeric values
    expect(runPayload.totalReturn).toBe(resultPayload.totalReturn);
    expect(runPayload.sharpe).toBe(resultPayload.sharpe);
    expect(runPayload.finalEquity).toBe(resultPayload.finalEquity);
  });

  it("fin_strategy_tick regime (no detector): regimeSource=default, regime=sideways", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const ohlcvData = makeOHLCV(60);

    const services = new Map<string, unknown>();
    services.set("fin-data-provider", { getOHLCV: async () => ohlcvData });
    // No fin-regime-detector service
    const { api, tools } = captureTools(services);

    registerStrategyTools(api as never, registry, engine, null, null);

    // Create & promote to L2
    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "Tick Default",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;
    registry.updateLevel(strategyId, "L2_PAPER");

    const tickFn = tools.get("fin_strategy_tick")!;
    const result = await tickFn("test-id", { strategyId });
    const payload = parseDetails(result);

    expect(payload.regimeSource).toBe("default");
    expect(payload.regime).toBe("sideways");
  });

  it("fin_strategy_tick regime (with detector): regimeSource=detector, regime=bull", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const ohlcvData = makeOHLCV(60);

    const services = new Map<string, unknown>();
    services.set("fin-data-provider", { getOHLCV: async () => ohlcvData });
    services.set("fin-regime-detector", { detect: () => "bull" });
    const { api, tools } = captureTools(services);

    registerStrategyTools(api as never, registry, engine, null, null);

    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "Tick Detector",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;
    registry.updateLevel(strategyId, "L2_PAPER");

    const tickFn = tools.get("fin_strategy_tick")!;
    const result = await tickFn("test-id", { strategyId });
    const payload = parseDetails(result);

    expect(payload.regimeSource).toBe("detector");
    expect(payload.regime).toBe("bull");
  });

  it("fin_strategy_create error: type=custom without rules → error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const { api, tools } = captureTools();

    registerStrategyTools(api as never, registry, engine, null, null);

    const execute = tools.get("fin_strategy_create")!;
    const result = await execute("test-id", {
      name: "Bad Custom",
      type: "custom",
      // No rules provided
    });

    const payload = parseDetails(result);
    expect(payload.error).toBeDefined();
    expect(typeof payload.error).toBe("string");
  });

  it("fin_backtest_run error: no data provider → error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const { api, tools } = captureTools(); // no services

    registerStrategyTools(api as never, registry, engine, null, null);

    // Create strategy first
    const createFn = tools.get("fin_strategy_create")!;
    const createResult = await createFn("test-id", {
      name: "No Data",
      type: "sma-crossover",
    });
    const strategyId = (parseDetails(createResult) as { id: string }).id;

    const btFn = tools.get("fin_backtest_run")!;
    const result = await btFn("test-id", { strategyId });
    const payload = parseDetails(result);

    expect(payload.error).toBeDefined();
    expect(typeof payload.error).toBe("string");
    expect((payload.error as string).toLowerCase()).toContain("provider");
  });

  it("fin_strategy_tick error: strategy not found → error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new BacktestEngine();
    const { api, tools } = captureTools();

    registerStrategyTools(api as never, registry, engine, null, null);

    const tickFn = tools.get("fin_strategy_tick")!;
    const result = await tickFn("test-id", { strategyId: "nonexistent-id" });
    const payload = parseDetails(result);

    expect(payload.error).toBeDefined();
    expect(typeof payload.error).toBe("string");
    expect((payload.error as string).toLowerCase()).toContain("not found");
  });
});
