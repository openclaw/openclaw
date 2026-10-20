/** Tests attempt-local settings and scope-read error boundaries. */
import { describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";
import { readSettingsScope } from "./settings-storage.js";

type SettingsStorage = Parameters<typeof readSettingsScope>[0];

describe("settings scope reads", () => {
  it("uses a backend's pure read contract", () => {
    expect(
      readSettingsScope(
        {
          readSettingsScope: () => JSON.stringify({ defaultThinkingLevel: "high" }),
          withLock: () => {
            throw new Error("This backend only supports pure reads");
          },
        },
        "project",
      ),
    ).toEqual({ settings: { defaultThinkingLevel: "high" }, loadError: null });
  });

  it("preserves a backend error without losing the other scope", () => {
    const error = new Error("Global settings unavailable");
    const storage: SettingsStorage = {
      readSettingsScope: (scope) => {
        if (scope === "global") {
          throw error;
        }
        return JSON.stringify({ defaultThinkingLevel: "high" });
      },
      withLock: () => {
        throw new Error("This backend only supports pure reads");
      },
    };
    expect(readSettingsScope(storage, "global")).toEqual({ settings: {}, loadError: error });
    expect(readSettingsScope(storage, "project")).toEqual({
      settings: { defaultThinkingLevel: "high" },
      loadError: null,
    });
  });

  it("normalizes a non-Error backend failure without losing the other scope", () => {
    const failure = { code: "UNAVAILABLE" };
    const storage: SettingsStorage = {
      withLock: (scope, read) => {
        if (scope === "global") {
          // oxlint-disable-next-line typescript/only-throw-error -- Custom backends can throw non-Error values; exercise that normalization boundary.
          throw failure;
        }
        read(JSON.stringify({ defaultThinkingLevel: "high" }));
      },
    };
    const { settings, loadError } = readSettingsScope(storage, "global");
    expect(settings).toEqual({});
    expect(loadError).toBeInstanceOf(Error);
    expect(loadError?.message).toBe("Session settings could not be loaded");
    expect(loadError?.cause).toBe(failure);
    expect(readSettingsScope(storage, "project").settings).toEqual({
      defaultThinkingLevel: "high",
    });
  });

  it.each([
    { input: "{", error: SyntaxError },
    { input: "null", error: TypeError },
    { input: "42", error: TypeError },
    { input: "true", error: TypeError },
    { input: '"invalid"', error: TypeError },
  ])("isolates invalid settings $input to the affected scope", ({ input, error }) => {
    const storage: SettingsStorage = {
      readSettingsScope: (scope) => (scope === "global" ? input : '{"skills":["old-skill"]}'),
      withLock: () => {
        throw new Error("Unexpected write");
      },
    };
    expect(readSettingsScope(storage, "global")).toEqual({
      settings: {},
      loadError: expect.any(error),
    });
    expect(readSettingsScope(storage, "project")).toEqual({
      settings: { skills: ["old-skill"] },
      loadError: null,
    });
  });
});

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
