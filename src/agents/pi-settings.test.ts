import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  ensurePiCompactionReserveTokens,
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
      getCompactionReserveTokens: () => 32_000,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({ didOverride: false, reserveTokens: 32_000 });
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });
});
