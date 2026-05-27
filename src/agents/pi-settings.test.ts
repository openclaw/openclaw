import { describe, expect, it, vi } from "vitest";
import {
  applyPiCompactionSettingsFromConfig,
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
});
