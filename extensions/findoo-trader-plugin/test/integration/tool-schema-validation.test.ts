/**
 * AI tool schema validation tests — Phase C (F-5).
 * Calls tool.execute() directly, validates return JSON types.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RemoteBacktestBridge } from "../../src/strategy/remote-backtest-bridge.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";
import { registerStrategyTools } from "../../src/strategy/tools.js";

// --- helpers ---

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

/** Mock remote backtest service that returns deterministic results. */
function makeMockBacktestService() {
  return {
    async submit() {
      return {
        task: { task_id: "mock-t1", status: "completed" },
        report: {
          task_id: "mock-t1",
          performance: {
            totalReturn: 12.5,
            sharpe: 1.2,
            sortino: 1.5,
            maxDrawdown: -8.3,
            calmar: 0.9,
            winRate: 55.0,
            profitFactor: 1.8,
            totalTrades: 25,
            finalEquity: 11250,
          },
          equity_curve: [
            { date: "2024-01-01", equity: 10000 },
            { date: "2024-06-01", equity: 11250 },
          ],
          trade_journal: [],
        },
      };
    },
    toBacktestResult(
      report: Record<string, unknown>,
      meta: { strategyId: string; initialCapital: number },
    ) {
      const p = (report as { performance: Record<string, number> }).performance;
      return {
        strategyId: meta.strategyId,
        startDate: 0,
        endDate: 0,
        initialCapital: meta.initialCapital,
        finalEquity: p.finalEquity ?? meta.initialCapital,
        totalReturn: (p.totalReturn ?? 0) / 100,
        sharpe: p.sharpe ?? 0,
        sortino: p.sortino ?? 0,
        maxDrawdown: (p.maxDrawdown ?? 0) / 100,
        calmar: p.calmar ?? 0,
        winRate: (p.winRate ?? 0) / 100,
        profitFactor: p.profitFactor ?? 0,
        totalTrades: p.totalTrades ?? 0,
        trades: [],
        equityCurve: [10000, 11250],
        dailyReturns: [0.125],
      };
    },
  };
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
    const engine = new RemoteBacktestBridge(() => undefined);
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
    const engine = new RemoteBacktestBridge(() => undefined);
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
    const mockService = makeMockBacktestService();
    const engine = new RemoteBacktestBridge(() => mockService as never);

    const { api, tools } = captureTools();

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
    const mockService = makeMockBacktestService();
    const engine = new RemoteBacktestBridge(() => mockService as never);

    const { api, tools } = captureTools();

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
    const mockService = makeMockBacktestService();
    const engine = new RemoteBacktestBridge(() => mockService as never);

    const { api, tools } = captureTools();

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

  it("fin_strategy_create error: type=custom without rules → error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new RemoteBacktestBridge(() => undefined);
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

  it("fin_backtest_run error: no remote backtest service → error", async () => {
    const registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const engine = new RemoteBacktestBridge(() => undefined);
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
    expect((payload.error as string).toLowerCase()).toContain("backtest");
  });
});
