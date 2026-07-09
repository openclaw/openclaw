/** Tests session settings manager runtime overrides. */
import { describe, expect, it } from "vitest";
import {
  InMemorySettingsStorage,
  SettingsManager,
  type Settings,
  type SettingsScope,
} from "./settings-manager.js";

function writeSettings(
  storage: InMemorySettingsStorage,
  scope: SettingsScope,
  settings: Partial<Settings>,
): void {
  storage.withLock(scope, () => JSON.stringify(settings, null, 2));
}

describe("SettingsManager runtime overrides", () => {
  it("preserves compaction overrides after global setting writes", async () => {
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

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });
  });

  it("preserves runtime overrides after project setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 16_384 },
    });

    settingsManager.applyOverrides({ compaction: { reserveTokens: 50_000 } });
    settingsManager.setProjectPackages(["npm:@openclaw/example"]);

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
  });
});

describe("SettingsManager nested scope merge", () => {
  it("merges retry.provider fields split across global and project scopes", () => {
    const storage = new InMemorySettingsStorage();
    writeSettings(storage, "global", {
      retry: { provider: { timeoutMs: 30_000, maxRetries: 5 } },
    });
    writeSettings(storage, "project", {
      retry: { provider: { maxRetryDelayMs: 5_000 } },
    });

    const settingsManager = SettingsManager.fromStorage(storage);

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 30_000,
      maxRetries: 5,
      maxRetryDelayMs: 5_000,
    });
  });

  it("merges retry.provider fields split across persisted and runtime overrides", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: { provider: { timeoutMs: 30_000, maxRetries: 5 } },
    });

    settingsManager.applyOverrides({
      retry: { provider: { maxRetryDelayMs: 5_000 } },
    });
    settingsManager.applyOverrides({
      retry: { provider: { timeoutMs: 45_000 } },
    });

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 45_000,
      maxRetries: 5,
      maxRetryDelayMs: 5_000,
    });
  });
});
