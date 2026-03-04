import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { StrategyDefinition } from "../../src/shared/types.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

// Mock the file system to avoid real disk I/O in unit tests.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "[]"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

function makeDefinition(overrides?: Partial<StrategyDefinition>): StrategyDefinition {
  return {
    id: `strat-${Date.now()}`,
    name: "Test Strategy",
    version: "1.0.0",
    markets: ["crypto"],
    symbols: ["BTC/USDT"],
    timeframes: ["1h"],
    parameters: { fast: 10, slow: 20 },
    onBar: vi.fn() as unknown as StrategyDefinition["onBar"],
    ...overrides,
  };
}

describe("StrategyRegistry", () => {
  let registry: StrategyRegistry;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    registry = new StrategyRegistry("/tmp/test-strategies.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create L0 strategy from definition", () => {
    const def = makeDefinition({ id: "s1", name: "SMA Cross" });
    const record = registry.create(def);

    expect(record.id).toBe("s1");
    expect(record.name).toBe("SMA Cross");
    expect(record.level).toBe("L0_INCUBATE");
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.definition).toBe(def);
  });

  it("should list all strategies", () => {
    registry.create(makeDefinition({ id: "a" }));
    registry.create(makeDefinition({ id: "b" }));
    registry.create(makeDefinition({ id: "c" }));

    const list = registry.list();
    expect(list).toHaveLength(3);
  });

  it("should filter strategies by level", () => {
    registry.create(makeDefinition({ id: "s1" }));
    registry.create(makeDefinition({ id: "s2" }));
    registry.updateLevel("s2", "L1_BACKTEST");

    const l0 = registry.list({ level: "L0_INCUBATE" });
    const l1 = registry.list({ level: "L1_BACKTEST" });
    expect(l0).toHaveLength(1);
    expect(l1).toHaveLength(1);
  });

  it("should get strategy by id", () => {
    registry.create(makeDefinition({ id: "target" }));
    const found = registry.get("target");
    expect(found).toBeDefined();
    expect(found!.id).toBe("target");
  });

  it("should return undefined for non-existent id", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should update strategy status (pause/resume/kill)", () => {
    registry.create(makeDefinition({ id: "s1" }));

    registry.updateStatus("s1", "paused");
    expect(registry.get("s1")!.status).toBe("paused");

    registry.updateStatus("s1", "running");
    expect(registry.get("s1")!.status).toBe("running");

    registry.updateStatus("s1", "stopped");
    expect(registry.get("s1")!.status).toBe("stopped");
  });

  it("should promote strategy level (L0 -> L1 -> L2 -> L3)", () => {
    registry.create(makeDefinition({ id: "s1" }));
    expect(registry.get("s1")!.level).toBe("L0_INCUBATE");

    registry.updateLevel("s1", "L1_BACKTEST");
    expect(registry.get("s1")!.level).toBe("L1_BACKTEST");

    registry.updateLevel("s1", "L2_PAPER");
    expect(registry.get("s1")!.level).toBe("L2_PAPER");

    registry.updateLevel("s1", "L3_LIVE");
    expect(registry.get("s1")!.level).toBe("L3_LIVE");
  });

  it("should throw when updating level of non-existent strategy", () => {
    expect(() => registry.updateLevel("missing", "L1_BACKTEST")).toThrow(
      /Strategy missing not found/,
    );
  });

  it("should throw when updating status of non-existent strategy", () => {
    expect(() => registry.updateStatus("missing", "paused")).toThrow(/Strategy missing not found/);
  });

  it("should store backtest result", () => {
    registry.create(makeDefinition({ id: "s1" }));

    const backtestResult = {
      strategyId: "s1",
      startDate: Date.now() - 86400000 * 30,
      endDate: Date.now(),
      initialCapital: 10000,
      finalEquity: 12500,
      totalReturn: 25,
      sharpe: 1.8,
      sortino: 2.1,
      maxDrawdown: -0.12,
      calmar: 2.0,
      winRate: 0.55,
      profitFactor: 1.6,
      totalTrades: 42,
      trades: [],
      equityCurve: [10000, 10500, 11000, 12500],
      dailyReturns: [0.05, 0.05, 0.14],
    };

    registry.updateBacktest("s1", backtestResult);
    const record = registry.get("s1")!;
    expect(record.lastBacktest).toBeDefined();
    expect(record.lastBacktest!.totalReturn).toBe(25);
    expect(record.lastBacktest!.sharpe).toBe(1.8);
  });

  it("should persist to file on create", () => {
    registry.create(makeDefinition({ id: "s1" }));
    expect(writeFileSync).toHaveBeenCalled();
  });

  it("should load existing strategies from file", () => {
    const existingData = [
      {
        id: "loaded-1",
        name: "Loaded Strategy",
        version: "1.0.0",
        level: "L1_BACKTEST",
        definition: makeDefinition({ id: "loaded-1" }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingData));

    const loadedRegistry = new StrategyRegistry("/tmp/test.json");
    const record = loadedRegistry.get("loaded-1");
    expect(record).toBeDefined();
    expect(record!.level).toBe("L1_BACKTEST");
  });
});
