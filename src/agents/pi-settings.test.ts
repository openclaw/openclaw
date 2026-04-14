import { describe, expect, it, vi } from "vitest";
import {
  applyPiCompactionSettingsFromConfig,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
  resolveShareBasedTokenBudget,
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

  it("computes floor from share when context window is provided", () => {
    // 200k window × 0.1 share = 20_000
    expect(
      resolveCompactionReserveTokensFloor(
        { agents: { defaults: { compaction: { reserveTokensFloorShare: 0.1 } } } },
        200_000,
      ),
    ).toBe(20_000);
    // 1M window × 0.1 share = 100_000 (scales up for larger window)
    expect(
      resolveCompactionReserveTokensFloor(
        { agents: { defaults: { compaction: { reserveTokensFloorShare: 0.1 } } } },
        1_000_000,
      ),
    ).toBe(100_000);
    // 8k window × 0.1 share = 800 (scales down for small window)
    expect(
      resolveCompactionReserveTokensFloor(
        { agents: { defaults: { compaction: { reserveTokensFloorShare: 0.1 } } } },
        8_000,
      ),
    ).toBe(800);
  });

  it("prefers share over absolute when both are set", () => {
    expect(
      resolveCompactionReserveTokensFloor(
        {
          agents: {
            defaults: {
              compaction: { reserveTokensFloor: 50_000, reserveTokensFloorShare: 0.2 },
            },
          },
        },
        200_000,
      ),
    ).toBe(40_000); // 200k × 0.2 wins over 50_000 absolute
  });

  it("falls back to absolute when context window is unknown", () => {
    expect(
      resolveCompactionReserveTokensFloor(
        {
          agents: {
            defaults: {
              compaction: { reserveTokensFloor: 12_345, reserveTokensFloorShare: 0.2 },
            },
          },
        },
        undefined,
      ),
    ).toBe(12_345);
  });
});

describe("resolveShareBasedTokenBudget", () => {
  it("uses absolute value when share is not set (regression)", () => {
    expect(
      resolveShareBasedTokenBudget({
        absolute: 50_000,
        contextWindowTokens: 200_000,
        fallback: 9_999,
      }),
    ).toBe(50_000);
  });

  it("computes from context window when only share is set", () => {
    expect(
      resolveShareBasedTokenBudget({
        share: 0.25,
        contextWindowTokens: 200_000,
        fallback: 9_999,
      }),
    ).toBe(50_000);
  });

  it("prefers share over absolute when both set (precedence)", () => {
    expect(
      resolveShareBasedTokenBudget({
        share: 0.25,
        absolute: 12_345,
        contextWindowTokens: 200_000,
        fallback: 9_999,
      }),
    ).toBe(50_000);
  });

  it("falls back to absolute when share is set but context window is missing", () => {
    expect(
      resolveShareBasedTokenBudget({
        share: 0.25,
        absolute: 12_345,
        fallback: 9_999,
      }),
    ).toBe(12_345);
  });

  it("returns fallback when neither share nor absolute are usable", () => {
    expect(resolveShareBasedTokenBudget({ fallback: 9_999 })).toBe(9_999);
  });

  it("scales reasonably across heterogeneous context windows", () => {
    // Same 0.05 share over GLM 200k, Claude 200k, Kimi K2 1M, Gemma-2B 8k
    const share = 0.05;
    expect(
      resolveShareBasedTokenBudget({
        share,
        contextWindowTokens: 200_000,
        fallback: 0,
      }),
    ).toBe(10_000);
    expect(
      resolveShareBasedTokenBudget({
        share,
        contextWindowTokens: 1_000_000,
        fallback: 0,
      }),
    ).toBe(50_000);
    // Small window still gets a proportional share instead of over-reserving.
    expect(
      resolveShareBasedTokenBudget({
        share,
        contextWindowTokens: 8_000,
        fallback: 0,
      }),
    ).toBe(400);
  });
});

describe("applyPiCompactionSettingsFromConfig share-based budgets", () => {
  function mkSettings(current = { reserve: 16_000, keepRecent: 20_000 }) {
    return {
      getCompactionReserveTokens: () => current.reserve,
      getCompactionKeepRecentTokens: () => current.keepRecent,
      applyOverrides: vi.fn(),
    };
  }

  it("only absolute set → uses absolute (backward compat regression)", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 60_000, reserveTokensFloor: 0 },
          },
        },
      },
      contextWindowTokens: 200_000,
    });
    expect(result.compaction.reserveTokens).toBe(60_000);
  });

  it("only share set → computes from model context window", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokensShare: 0.25, reserveTokensFloor: 0 },
          },
        },
      },
      contextWindowTokens: 200_000,
    });
    expect(result.compaction.reserveTokens).toBe(50_000);
  });

  it("both absolute and share set → share wins", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokens: 10_000,
              reserveTokensShare: 0.25,
              reserveTokensFloor: 0,
            },
          },
        },
      },
      contextWindowTokens: 200_000,
    });
    expect(result.compaction.reserveTokens).toBe(50_000); // 200k × 0.25
  });

  it("share + floor → floor respected when share yields less", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokensShare: 0.01, reserveTokensFloor: 25_000 },
          },
        },
      },
      contextWindowTokens: 200_000,
    });
    // 200k × 0.01 = 2_000; floor lifts to 25_000
    expect(result.compaction.reserveTokens).toBe(25_000);
  });

  it("1M window + share scales up reasonably (heterogeneous-model scenario)", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokensShare: 0.1, reserveTokensFloor: 0 },
          },
        },
      },
      contextWindowTokens: 1_000_000,
    });
    expect(result.compaction.reserveTokens).toBe(100_000);
  });

  it("small window (8k) + share avoids over-reserving absolute numbers", () => {
    const settingsManager = mkSettings({ reserve: 0, keepRecent: 1_000 });
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokensShare: 0.2, reserveTokensFloor: 0 },
          },
        },
      },
      contextWindowTokens: 8_000,
    });
    expect(result.compaction.reserveTokens).toBe(1_600); // 8k × 0.2
  });

  it("keepRecentTokensShare is resolved when share is set", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokensShare: 0.1,
              reserveTokensFloor: 0,
            },
          },
        },
      },
      contextWindowTokens: 200_000,
    });
    expect(result.compaction.keepRecentTokens).toBe(20_000);
  });

  it("falls back to absolute fields when contextWindowTokens is omitted (backward compat)", () => {
    const settingsManager = mkSettings();
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokens: 30_000,
              reserveTokensShare: 0.5, // ignored without window
              reserveTokensFloor: 0,
            },
          },
        },
      },
    });
    expect(result.compaction.reserveTokens).toBe(30_000);
  });
});
