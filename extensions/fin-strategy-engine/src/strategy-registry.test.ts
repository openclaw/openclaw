import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrategyRegistry } from "./strategy-registry.js";
import type { StrategyDefinition, BacktestResult, WalkForwardResult } from "./types.js";

function mockDefinition(id = "test-strat"): StrategyDefinition {
  return {
    id,
    name: "Test Strategy",
    version: "1.0",
    markets: ["crypto"],
    symbols: ["BTC/USDT"],
    timeframes: ["1d"],
    parameters: { fast: 10, slow: 30 },
    async onBar() {
      return null;
    },
  };
}

function mockBacktestResult(strategyId: string): BacktestResult {
  return {
    strategyId,
    startDate: 1000000,
    endDate: 2000000,
    initialCapital: 10000,
    finalEquity: 12000,
    totalReturn: 20,
    sharpe: 1.5,
    sortino: 2.0,
    maxDrawdown: -5,
    calmar: 4,
    winRate: 60,
    profitFactor: 1.8,
    totalTrades: 10,
    trades: [],
    equityCurve: [10000, 12000],
    dailyReturns: [0.2],
  };
}

describe("StrategyRegistry", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fin-registry-test-"));
    filePath = join(tempDir, "state", "fin-strategies.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates and lists strategies", () => {
    const reg = new StrategyRegistry(filePath);
    const record = reg.create(mockDefinition("s1"));

    expect(record.id).toBe("s1");
    expect(record.level).toBe("L0_INCUBATE");

    const all = reg.list();
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe("s1");
  });

  it("gets a strategy by ID", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));

    const found = reg.get("s1");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Test Strategy");

    const notFound = reg.get("nonexistent");
    expect(notFound).toBeUndefined();
  });

  it("filters by level", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));
    reg.create(mockDefinition("s2"));
    reg.updateLevel("s2", "L1_BACKTEST");

    const incubating = reg.list({ level: "L0_INCUBATE" });
    expect(incubating.length).toBe(1);
    expect(incubating[0]!.id).toBe("s1");

    const backtested = reg.list({ level: "L1_BACKTEST" });
    expect(backtested.length).toBe(1);
    expect(backtested[0]!.id).toBe("s2");
  });

  it("updates level and persists", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));
    reg.updateLevel("s1", "L2_PAPER");

    // Reload from disk
    const reg2 = new StrategyRegistry(filePath);
    const record = reg2.get("s1");
    expect(record).toBeDefined();
    expect(record!.level).toBe("L2_PAPER");
  });

  it("stores backtest result", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));

    const bt = mockBacktestResult("s1");
    reg.updateBacktest("s1", bt);

    const record = reg.get("s1");
    expect(record!.lastBacktest).toBeDefined();
    expect(record!.lastBacktest!.sharpe).toBe(1.5);
  });

  it("stores walk-forward result", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));

    const wf: WalkForwardResult = {
      passed: true,
      windows: [],
      combinedTestSharpe: 1.2,
      avgTrainSharpe: 1.5,
      ratio: 0.8,
      threshold: 0.6,
    };
    reg.updateWalkForward("s1", wf);

    const record = reg.get("s1");
    expect(record!.lastWalkForward).toBeDefined();
    expect(record!.lastWalkForward!.passed).toBe(true);
  });

  it("throws when updating nonexistent strategy", () => {
    const reg = new StrategyRegistry(filePath);
    expect(() => reg.updateLevel("nope", "L1_BACKTEST")).toThrow("not found");
  });

  it("handles missing file gracefully", () => {
    const reg = new StrategyRegistry(join(tempDir, "nonexistent", "file.json"));
    expect(reg.list()).toEqual([]);
  });

  it("persists across instances", () => {
    const reg1 = new StrategyRegistry(filePath);
    reg1.create(mockDefinition("s1"));
    reg1.create(mockDefinition("s2"));

    const reg2 = new StrategyRegistry(filePath);
    expect(reg2.list().length).toBe(2);
  });

  it("increments version when definition changes", () => {
    const reg = new StrategyRegistry(filePath);
    const def = mockDefinition("s1");
    reg.create(def);

    const updatedDef: StrategyDefinition = {
      id: "s1",
      name: "Test Strategy",
      version: "1.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
      parameters: { fast: 15, slow: 30 },
      async onBar() {
        return null;
      },
    };
    reg.updateDefinition("s1", updatedDef);

    const record = reg.get("s1");
    expect(record!.version).toBe("1.1");
    expect(record!.definition.parameters.fast).toBe(15);
  });

  it("does not increment version when definition is identical", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create(mockDefinition("s1"));

    const sameDef: StrategyDefinition = {
      ...mockDefinition("s1"),
      async onBar() {
        return null;
      },
    };
    reg.updateDefinition("s1", sameDef);

    const record = reg.get("s1");
    expect(record!.version).toBe("1.0");
  });

  it("increments semver version correctly", () => {
    const reg = new StrategyRegistry(filePath);
    reg.create({
      id: "s1",
      name: "Test Strategy",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
      parameters: { fast: 10, slow: 30 },
      async onBar() {
        return null;
      },
    });

    const updatedDef: StrategyDefinition = {
      id: "s1",
      name: "Test Strategy",
      version: "1.0.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
      parameters: { fast: 15, slow: 30 },
      async onBar() {
        return null;
      },
    };
    reg.updateDefinition("s1", updatedDef);

    const record = reg.get("s1");
    expect(record!.version).toBe("1.0.1");
  });

  it("throws when updating definition of nonexistent strategy", () => {
    const reg = new StrategyRegistry(filePath);
    expect(() => reg.updateDefinition("nonexistent", mockDefinition())).toThrow("not found");
  });
});
