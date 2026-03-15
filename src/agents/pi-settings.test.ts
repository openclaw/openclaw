import { describe, expect, it, vi } from "vitest";
import {
  applyPiCompactionSettingsFromConfig,
  calculateAdaptiveReserveTokensFloor,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

describe("applyPiCompactionSettingsFromConfig", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(result.didOverride).toBe(false);
    expect(result.compaction.reserveTokens).toBe(32_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies explicit reserveTokens but still enforces floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 10_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 12_000, reserveTokensFloor: 20_000 },
          },
        },
      },
    });

    expect(result.compaction.reserveTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 20_000 },
    });
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokens: 15_000,
            },
          },
        },
      },
    });

    expect(result.compaction.keepRecentTokens).toBe(15_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard" } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("treats keepRecentTokens=0 as invalid and keeps the current setting", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard", keepRecentTokens: 0 } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
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

  it("uses adaptive calculation when contextWindow is provided", () => {
    // Small model (≤64k): uses default 20k
    expect(resolveCompactionReserveTokensFloor(undefined, 8192)).toBe(20_000);
    expect(resolveCompactionReserveTokensFloor(undefined, 32768)).toBe(20_000);
    expect(resolveCompactionReserveTokensFloor(undefined, 65536)).toBe(20_000);

    // Medium model (64k-256k): 10% of context window
    expect(resolveCompactionReserveTokensFloor(undefined, 128_000)).toBe(20_000); // 12.8k < 20k, min applies
    expect(resolveCompactionReserveTokensFloor(undefined, 200_000)).toBe(20_000); // 20k = default
    expect(resolveCompactionReserveTokensFloor(undefined, 262_144)).toBe(26_214); // 10% of 262k

    // Large model (>256k): 5% with 30k minimum
    expect(resolveCompactionReserveTokensFloor(undefined, 1_000_000)).toBe(50_000); // 5% of 1M
    expect(resolveCompactionReserveTokensFloor(undefined, 2_000_000)).toBe(100_000); // 5% of 2M
  });

  it("user config override takes precedence over adaptive calculation", () => {
    const cfg = { agents: { defaults: { compaction: { reserveTokensFloor: 40_000 } } } };
    expect(resolveCompactionReserveTokensFloor(cfg, 1_000_000)).toBe(40_000);
    expect(resolveCompactionReserveTokensFloor(cfg, 262_144)).toBe(40_000);
  });
});

describe("calculateAdaptiveReserveTokensFloor", () => {
  it("returns default floor for small models (≤64k)", () => {
    expect(calculateAdaptiveReserveTokensFloor(8192)).toBe(20_000);
    expect(calculateAdaptiveReserveTokensFloor(32768)).toBe(20_000);
    expect(calculateAdaptiveReserveTokensFloor(65536)).toBe(20_000);
  });

  it("returns 10% of context for medium models (64k-256k)", () => {
    expect(calculateAdaptiveReserveTokensFloor(100_000)).toBe(20_000); // min applies
    expect(calculateAdaptiveReserveTokensFloor(200_000)).toBe(20_000); // exactly default
    expect(calculateAdaptiveReserveTokensFloor(250_000)).toBe(25_000);
    expect(calculateAdaptiveReserveTokensFloor(262_144)).toBe(26_214);
  });

  it("returns 5% with 30k minimum for large models (>256k)", () => {
    expect(calculateAdaptiveReserveTokensFloor(300_000)).toBe(30_000); // min applies (15k < 30k)
    expect(calculateAdaptiveReserveTokensFloor(500_000)).toBe(30_000); // min applies (25k < 30k)
    expect(calculateAdaptiveReserveTokensFloor(600_000)).toBe(30_000); // min applies (30k = min)
    expect(calculateAdaptiveReserveTokensFloor(1_000_000)).toBe(50_000);
    expect(calculateAdaptiveReserveTokensFloor(2_000_000)).toBe(100_000);
  });
});
