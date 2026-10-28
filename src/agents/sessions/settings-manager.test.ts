/** Tests attempt-local settings. */
import { describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";

describe("SettingsManager runtime overrides", () => {
  it("preserves compaction overrides after local setting writes", () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });
    settingsManager.applyOverrides({
      compaction: { reserveTokens: 50_000, keepRecentTokens: 16_000 },
    });
    settingsManager.setCompactionEnabled(false);
    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });
  });

  it("keeps mutable defaults separate from a shared frozen input", () => {
    const input = Object.freeze({
      defaultThinkingLevel: "low" as const,
      compaction: Object.freeze({ enabled: true, reserveTokens: 16_384 }),
    });
    const settingsManager = SettingsManager.inMemory(input);
    settingsManager.setDefaultThinkingLevel("high");
    settingsManager.setCompactionEnabled(false);
    expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
    expect(settingsManager.getCompactionEnabled()).toBe(false);
    expect(input.defaultThinkingLevel).toBe("low");
    expect(input.compaction).toEqual({ enabled: true, reserveTokens: 16_384 });
    const next = SettingsManager.inMemory(input);
    expect(next.getDefaultThinkingLevel()).toBe("low");
    expect(next.getCompactionEnabled()).toBe(true);
  });

  it("recursively merges provider retry overrides", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: {
        provider: { timeoutMs: 30_000, maxRetryDelayMs: 60_000 },
      },
    });
    settingsManager.applyOverrides({ retry: { provider: { timeoutMs: 45_000 } } });
    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 45_000,
      maxRetryDelayMs: 60_000,
    });
  });
});
