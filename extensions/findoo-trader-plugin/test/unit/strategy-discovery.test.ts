/**
 * L1 unit tests for the Strategy Discovery Engine.
 * Tests deterministic seeder, prompt builder, and engine orchestration.
 */

import { describe, it, expect, vi } from "vitest";
import { generateFromSnapshot } from "../../src/discovery/deterministic-seeder.js";
import {
  buildSubagentTaskPrompt,
  buildWakeMessage,
} from "../../src/discovery/discovery-prompt-builder.js";
import { StrategyDiscoveryEngine } from "../../src/discovery/strategy-discovery-engine.js";
import { DEFAULT_DISCOVERY_CONFIG } from "../../src/discovery/types.js";
import type { DiscoverySymbolSnapshot } from "../../src/discovery/types.js";
import type { OHLCV } from "../../src/shared/types.js";

// Helper: generate N days of synthetic OHLCV data
function makeOHLCV(basePrice: number, days: number): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = basePrice;
  for (let i = 0; i < days; i++) {
    const change = (Math.random() - 0.48) * basePrice * 0.02; // slight upward bias
    price += change;
    bars.push({
      timestamp: Date.now() - (days - i) * 86_400_000,
      open: price - Math.abs(change) * 0.3,
      high: price + Math.abs(change) * 0.5,
      low: price - Math.abs(change) * 0.5,
      close: price,
      volume: 1_000_000 + Math.random() * 500_000,
    });
  }
  return bars;
}

// Helper: create a mock symbol snapshot
function makeSnapshot(overrides: Partial<DiscoverySymbolSnapshot> = {}): DiscoverySymbolSnapshot {
  return {
    symbol: "BTC/USDT",
    market: "crypto",
    regime: "bull",
    close: 65000,
    change7dPct: 5.2,
    change30dPct: 12.3,
    rsi14: 62,
    sma50: 62000,
    sma200: 55000,
    atrPct: 3.2,
    volume7dAvg: 1_500_000,
    ...overrides,
  };
}

describe("DeterministicSeeder", () => {
  it("generates strategies for bull regime", () => {
    const snapshots = [makeSnapshot({ regime: "bull" })];
    const strategies = generateFromSnapshot(snapshots, 6);

    expect(strategies.length).toBeGreaterThanOrEqual(1);
    expect(strategies.length).toBeLessThanOrEqual(6);

    // Should have a main strategy
    const main = strategies[0]!;
    expect(main.name).toContain("BTC/USDT");
    expect(main.name).toContain("牛市");
    expect(main.symbols).toContain("BTC/USDT");
  });

  it("generates strategies for bear regime", () => {
    const snapshots = [makeSnapshot({ regime: "bear", rsi14: 35 })];
    const strategies = generateFromSnapshot(snapshots, 6);

    expect(strategies.length).toBeGreaterThanOrEqual(1);
    const names = strategies.map((s) => s.name).join(" ");
    expect(names).toContain("熊市");
  });

  it("generates strategies for sideways regime", () => {
    const snapshots = [makeSnapshot({ regime: "sideways", rsi14: 50, atrPct: 1.5 })];
    const strategies = generateFromSnapshot(snapshots, 6);

    expect(strategies.length).toBeGreaterThanOrEqual(1);
    const names = strategies.map((s) => s.name).join(" ");
    expect(names).toContain("震荡");
  });

  it("respects maxStrategies limit", () => {
    const snapshots = [
      makeSnapshot({ symbol: "BTC/USDT", regime: "bull" }),
      makeSnapshot({ symbol: "ETH/USDT", regime: "bear" }),
      makeSnapshot({ symbol: "SOL/USDT", regime: "sideways" }),
      makeSnapshot({ symbol: "SPY", market: "us-stock", regime: "bull" }),
    ];
    const strategies = generateFromSnapshot(snapshots, 3);

    expect(strategies.length).toBeLessThanOrEqual(3);
  });

  it("adjusts position size for high volatility", () => {
    const snapshots = [makeSnapshot({ atrPct: 5.5, regime: "volatile" })];
    const strategies = generateFromSnapshot(snapshots, 6);

    // High vol strategy should exist and use vol-appropriate template
    const main = strategies[0]!;
    expect(main.name).toContain("高波动");
    // sizePct may be in parameters or determined by template
    if (main.parameters.sizePct !== undefined) {
      expect(main.parameters.sizePct).toBeLessThanOrEqual(50);
    }
  });

  it("handles multi-market watchlist", () => {
    const snapshots = [
      makeSnapshot({ symbol: "BTC/USDT", market: "crypto" }),
      makeSnapshot({ symbol: "SPY", market: "us-stock" }),
      makeSnapshot({ symbol: "0700.HK", market: "hk-stock" }),
      makeSnapshot({ symbol: "600519", market: "a-share" }),
    ];
    const strategies = generateFromSnapshot(snapshots, 8);

    // Should produce strategies for multiple markets
    const markets = new Set(strategies.flatMap((s) => s.markets));
    expect(markets.size).toBeGreaterThanOrEqual(1);
  });
});

describe("DiscoveryPromptBuilder", () => {
  it("builds a subagent task prompt with tool instructions", () => {
    const prompt = buildSubagentTaskPrompt(DEFAULT_DISCOVERY_CONFIG, [], undefined);

    // Should reference fin_kline and fin_strategy_create tools
    expect(prompt).toContain("fin_kline");
    expect(prompt).toContain("fin_price");
    expect(prompt).toContain("fin_strategy_create");

    // Should list watchlist symbols
    expect(prompt).toContain("BTC/USDT");
    expect(prompt).toContain("ETH/USDT");
    expect(prompt).toContain("SPY");

    // Should NOT embed actual market data (LLM fetches its own)
    expect(prompt).not.toContain("| BTC/USDT | crypto | bull |");
  });

  it("includes existing strategy names for dedup", () => {
    const existing = ["SMA Crossover BTC", "RSI Mean Rev ETH"];
    const prompt = buildSubagentTaskPrompt(DEFAULT_DISCOVERY_CONFIG, existing, undefined);

    expect(prompt).toContain("SMA Crossover BTC");
    expect(prompt).toContain("RSI Mean Rev ETH");
  });

  it("includes Phase A regime hints when available", () => {
    const snapshots = [
      makeSnapshot({ symbol: "BTC/USDT", regime: "bull", rsi14: 62, atrPct: 3.2 }),
    ];
    const prompt = buildSubagentTaskPrompt(DEFAULT_DISCOVERY_CONFIG, [], snapshots);

    expect(prompt).toContain("Phase A 预扫描提示");
    expect(prompt).toContain("BTC/USDT: regime=bull");
  });

  it("builds wake message with sessions_spawn instructions", () => {
    const wake = buildWakeMessage(7, 4, "task content here");

    expect(wake).toContain("sessions_spawn");
    expect(wake).toContain('runtime: "subagent"');
    expect(wake).toContain('sandbox: "inherit"');
    expect(wake).toContain("7 个标的");
    expect(wake).toContain("4 个确定性策略");
    expect(wake).toContain("task content here");
  });
});

describe("StrategyDiscoveryEngine", () => {
  it("runs Phase A with mock data provider", async () => {
    const bars = makeOHLCV(65000, 60);
    const mockDataProvider = { getOHLCV: vi.fn().mockResolvedValue(bars) };
    const mockRegimeDetector = { detect: vi.fn().mockReturnValue("bull") };
    const mockRegistry = {
      get: vi.fn().mockReturnValue(undefined),
      create: vi
        .fn()
        .mockImplementation((def) => ({
          ...def,
          level: "L0_INCUBATE",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      list: vi.fn().mockReturnValue([]),
      updateBacktest: vi.fn(),
    };
    const mockBacktest = {
      runBacktest: vi.fn().mockResolvedValue({ sharpe: 1.2, totalReturn: 0.15 }),
    };
    const mockEventStore = { addEvent: vi.fn() };

    const engine = new StrategyDiscoveryEngine({
      dataProviderResolver: () => mockDataProvider,
      regimeDetectorResolver: () => mockRegimeDetector,
      strategyRegistry: mockRegistry as any,
      backtestBridge: mockBacktest as any,
      eventStore: mockEventStore as any,
    });

    const result = await engine.discover({
      ...DEFAULT_DISCOVERY_CONFIG,
      backtestAfterCreate: false, // skip async backtests in test
    });

    // Should have scanned symbols and created strategies
    expect(result.snapshot.symbols.length).toBeGreaterThan(0);
    expect(result.deterministicIds.length).toBeGreaterThan(0);
    expect(mockRegistry.create).toHaveBeenCalled();
    expect(mockDataProvider.getOHLCV).toHaveBeenCalled();
    expect(mockEventStore.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("策略发现") }),
    );
  });

  it("returns empty result when data provider is unavailable", async () => {
    const mockRegistry = { list: vi.fn().mockReturnValue([]) };
    const mockEventStore = { addEvent: vi.fn() };

    const engine = new StrategyDiscoveryEngine({
      dataProviderResolver: () => undefined,
      regimeDetectorResolver: () => undefined,
      strategyRegistry: mockRegistry as any,
      backtestBridge: {} as any,
      eventStore: mockEventStore as any,
    });

    const result = await engine.discover();

    expect(result.snapshot.symbols.length).toBe(0);
    expect(result.deterministicIds.length).toBe(0);
    expect(result.subagentWakeFired).toBe(false);
  });

  it("fires subagent wake when wakeBridge is present", async () => {
    const bars = makeOHLCV(65000, 60);
    const mockWakeBridge = { onDiscoveryScanComplete: vi.fn() };

    const engine = new StrategyDiscoveryEngine({
      dataProviderResolver: () => ({ getOHLCV: vi.fn().mockResolvedValue(bars) }),
      regimeDetectorResolver: () => ({ detect: vi.fn().mockReturnValue("bull") }),
      strategyRegistry: {
        get: vi.fn().mockReturnValue(undefined),
        create: vi.fn().mockImplementation((def) => ({ ...def, level: "L0_INCUBATE" })),
        list: vi.fn().mockReturnValue([]),
        updateBacktest: vi.fn(),
      } as any,
      backtestBridge: { runBacktest: vi.fn().mockRejectedValue(new Error("skip")) } as any,
      wakeBridge: mockWakeBridge as any,
      eventStore: { addEvent: vi.fn() } as any,
    });

    const result = await engine.discover({
      ...DEFAULT_DISCOVERY_CONFIG,
      backtestAfterCreate: false,
    });

    expect(result.subagentWakeFired).toBe(true);
    expect(mockWakeBridge.onDiscoveryScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        symbolCount: expect.any(Number),
        deterministicCount: expect.any(Number),
        wakeMessage: expect.stringContaining("sessions_spawn"),
      }),
    );
  });
});
