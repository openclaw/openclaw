import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  ensurePiCompactionReserveTokens,
  resolveBackgroundOptimization,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

describe("ensurePiCompactionReserveTokens", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({
      didOverride: true,
      reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
    });
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 50_000,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({ didOverride: false, reserveTokens: 50_000 });
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});

describe("resolveBackgroundOptimization", () => {
  it("returns all defaults when config is missing", () => {
    const result = resolveBackgroundOptimization();
    expect(result).toEqual({
      verbatimTurns: 30,
      targetWaterLevel: 0.5,
      summaryBudgetRatio: 0.25,
      optimizeAfterTurns: 15,
      optimizeIntervalMin: 20,
    });
  });

  it("accepts partial overrides and fills defaults", () => {
    const result = resolveBackgroundOptimization({
      agents: {
        defaults: {
          compaction: {
            backgroundOptimization: { verbatimTurns: 10, targetWaterLevel: 0.7 },
          },
        },
      },
    });
    expect(result.verbatimTurns).toBe(10);
    expect(result.targetWaterLevel).toBe(0.7);
    expect(result.summaryBudgetRatio).toBe(0.25);
    expect(result.optimizeAfterTurns).toBe(15);
    expect(result.optimizeIntervalMin).toBe(20);
  });

  it("clamps out-of-range values", () => {
    const result = resolveBackgroundOptimization({
      agents: {
        defaults: {
          compaction: {
            backgroundOptimization: {
              verbatimTurns: 0,
              targetWaterLevel: 2.0,
              summaryBudgetRatio: -1,
              optimizeAfterTurns: 999,
              optimizeIntervalMin: 0,
            },
          },
        },
      },
    });
    expect(result.verbatimTurns).toBe(1);
    expect(result.targetWaterLevel).toBe(0.9);
    expect(result.summaryBudgetRatio).toBe(0.05);
    expect(result.optimizeAfterTurns).toBe(100);
    expect(result.optimizeIntervalMin).toBe(1);
  });
});
