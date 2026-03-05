/**
 * L2 Integration test — real StrategyRegistry + DeduplicationFilter + ActivityLogStore.
 * Verifies the ideation pipeline end-to-end with real (non-mocked) components.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import { DeduplicationFilter } from "../../src/ideation/dedup-filter.js";
import { IdeationEngine } from "../../src/ideation/ideation-engine.js";
import { IdeationScheduler } from "../../src/ideation/ideation-scheduler.js";
import { MarketScanner } from "../../src/ideation/market-scanner.js";
import type { OHLCV } from "../../src/shared/types.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

function makeBars(count: number, basePrice = 100): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const price = basePrice + Math.sin(i * 0.1) * 5;
    bars.push({
      timestamp: Date.now() - (count - i) * 86_400_000,
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000,
    });
  }
  return bars;
}

describe("Ideation Integration (L2)", () => {
  let tmpDir: string;
  let activityLog: ActivityLogStore;
  let strategyRegistry: StrategyRegistry;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `ideation-l2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    activityLog = new ActivityLogStore(join(tmpDir, "activity.sqlite"));
    strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));
  });

  afterAll(() => {
    try {
      activityLog.close();
    } catch {
      /* */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("full pipeline: scan → engine → dedup → activity log records", async () => {
    const bars = makeBars(300);
    const getOHLCV = vi.fn().mockResolvedValue(bars);
    const onIdeationScanComplete = vi.fn();

    const scanner = new MarketScanner({
      dataProviderResolver: () => ({ getOHLCV }),
      regimeDetectorResolver: () => undefined,
    });

    const engine = new IdeationEngine({
      wakeBridge: { onIdeationScanComplete } as never,
      activityLog,
    });

    const filter = new DeduplicationFilter(strategyRegistry);

    const scheduler = new IdeationScheduler({
      scanner,
      engine,
      filter,
      activityLog,
      existingStrategyNamesResolver: () => strategyRegistry.list().map((s) => s.name),
    });

    const result = await scheduler.runCycle();

    // Scan should have been called
    expect(getOHLCV).toHaveBeenCalled();

    // Engine should have been triggered (unless 0 symbols)
    expect(result.snapshot.symbols.length).toBeGreaterThan(0);

    // Activity log should have entries
    const entries = activityLog.listRecent(20, "ideation");
    expect(entries.length).toBeGreaterThanOrEqual(2); // cycle_start + cycle_complete (or wake)
  });

  it("dedup filter works with real registry containing strategies", () => {
    // Create a strategy in the real registry
    strategyRegistry.create({
      id: "sma-crossover",
      name: "SMA Cross BTC",
      version: "1.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1h"],
      parameters: { fastPeriod: 10, slowPeriod: 30 },
      onBar: async () => null,
    });

    const filter = new DeduplicationFilter(strategyRegistry);

    // Try to create same template + symbol → should be rejected
    const { accepted, rejected } = filter.filter(
      [
        {
          templateId: "sma-crossover",
          symbol: "BTC/USDT",
          timeframe: "1h",
          parameters: { fastPeriod: 15, slowPeriod: 40 },
          rationale: "test",
          confidence: 0.8,
        },
      ],
      3,
    );

    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("exact_match");
  });

  it("activity log persists ideation category entries", () => {
    activityLog.append({
      category: "ideation",
      action: "test_entry",
      detail: "Integration test entry",
      metadata: { test: true },
    });

    const entries = activityLog.listRecent(5, "ideation");
    const found = entries.find((e) => e.action === "test_entry");
    expect(found).toBeDefined();
    expect(found!.metadata).toEqual({ test: true });
  });
});
