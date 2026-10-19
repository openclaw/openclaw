/** Tests session settings loading, persistence, and runtime overrides. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

class InspectableSettingsStorage implements SettingsStorage {
  private values: Record<SettingsScope, string | undefined> = {
    global: undefined,
    project: undefined,
  };

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.values[scope]);
    if (next !== undefined) {
      this.values[scope] = next;
    }
  }

  set(scope: SettingsScope, value: unknown): void {
    this.values[scope] = typeof value === "string" ? value : JSON.stringify(value);
  }

  get(scope: SettingsScope): unknown {
    const value = this.values[scope];
    return value === undefined ? undefined : JSON.parse(value);
  }
}

describe("SettingsManager scoped persistence", () => {
  it.each(
    [
      {
        retired: { queueMode: "all" },
        canonical: { steeringMode: "all" },
        guidance: "steeringMode",
      },
      { retired: { websockets: false }, canonical: { transport: "sse" }, guidance: "transport" },
      {
        retired: { skills: { customDirectories: ["custom-skill"], enableSkillCommands: false } },
        canonical: { skills: ["custom-skill"], enableSkillCommands: false },
        guidance: "enableSkillCommands",
      },
      {
        retired: { retry: { maxDelayMs: 12_000 } },
        canonical: { retry: { provider: { maxRetryDelayMs: 12_000 } } },
        guidance: "retry.provider.maxRetryDelayMs",
      },
    ].flatMap((settings) => [
      { ...settings, scope: "global" },
      { ...settings, scope: "project" },
    ]),
  )(
    "refuses retired $scope settings with $guidance guidance and preserves bytes",
    async ({ retired, canonical, guidance, scope }) => {
      const root = tempDirs.make("openclaw-settings-retired-");
      const agentDir = join(root, "agent");
      const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
      const settingsPath = join(settingsDir, "settings.json");
      mkdirSync(settingsDir);
      const original = `${JSON.stringify({ theme: "keep", ...retired }, null, 4)}\n`;
      writeFileSync(settingsPath, original);
      const refusal = expect.objectContaining({
        code: "INVALID_CONFIG",
        recovery: "manual",
        message: expect.stringContaining(guidance),
      });

      expect(() => SettingsManager.create(root, agentDir)).toThrowError(refusal);
      expect(readFileSync(settingsPath, "utf8")).toBe(original);

      writeFileSync(settingsPath, JSON.stringify(canonical));
      const manager = SettingsManager.create(root, agentDir);
      expect(manager.drainErrors()).toEqual([]);
      expect(
        scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings(),
      ).toEqual(canonical);

      writeFileSync(settingsPath, original);
      await expect(manager.reload()).rejects.toThrowError(refusal);
      expect(readFileSync(settingsPath, "utf8")).toBe(original);
    },
  );

  it("loads settings from a backend that supplies the pure read contract", () => {
    const manager = SettingsManager.fromStorage({
      readSettingsScope: (scope) =>
        JSON.stringify({ defaultThinkingLevel: scope === "global" ? "low" : "high" }),
      withLock: () => {
        throw new Error("This backend only supports pure reads");
      },
    });
    expect(manager.drainErrors()).toEqual([]);
    expect(manager.getGlobalSettings()).toEqual({ defaultThinkingLevel: "low" });
    expect(manager.getProjectSettings()).toEqual({ defaultThinkingLevel: "high" });
    expect(manager.getDefaultThinkingLevel()).toBe("high");
  });

  it("preserves a pure-read backend error and still loads the other scope", () => {
    const error = new Error("Global settings unavailable");
    const manager = SettingsManager.fromStorage({
      readSettingsScope: (scope) => {
        if (scope === "global") {
          throw error;
        }
        return JSON.stringify({ defaultThinkingLevel: "high" });
      },
      withLock: () => {
        throw new Error("This backend only supports pure reads");
      },
    });
    const errors = manager.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.scope).toBe("global");
    expect(errors[0]?.error).toBe(error);
    expect(manager.getGlobalSettings()).toEqual({});
    expect(manager.getDefaultThinkingLevel()).toBe("high");
  });

  it("normalizes a non-Error backend failure without losing the other scope", () => {
    const failure = { code: "UNAVAILABLE" };
    const manager = SettingsManager.fromStorage({
      withLock: (scope, read) => {
        if (scope === "global") {
          // oxlint-disable-next-line typescript/only-throw-error -- Custom backends can throw non-Error values; exercise that normalization boundary.
          throw failure;
        }
        read(JSON.stringify({ defaultThinkingLevel: "high" }));
      },
    });
    const errors = manager.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.scope).toBe("global");
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(errors[0]?.error.message).toBe("Session settings could not be loaded");
    expect(errors[0]?.error.cause).toBe(failure);
    expect(manager.getGlobalSettings()).toEqual({});
    expect(manager.getDefaultThinkingLevel()).toBe("high");
  });

  it("preserves external sibling changes while writing global settings", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", {
      compaction: { enabled: true, reserveTokens: 16_384 },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/project"],
      skills: ["old-skill"],
    });
    const settingsManager = SettingsManager.fromStorage(storage);

    settingsManager.setCompactionEnabled(false);
    storage.set("global", {
      compaction: { enabled: true, reserveTokens: 32_768, keepRecentTokens: 8_000 },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.flush();

    expect(storage.get("global")).toEqual({
      compaction: { enabled: false, reserveTokens: 32_768, keepRecentTokens: 8_000 },
      packages: ["npm:@openclaw/global"],
    });
    expect(storage.get("project")).toEqual({
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.reload();
    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 32_768,
      keepRecentTokens: 8_000,
    });
    expect(settingsManager.getProjectSettings()).toEqual({
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });
  });

  it.each([
    { input: "{", error: SyntaxError, expected: undefined },
    { input: "null", error: TypeError, expected: null },
    { input: "42", error: TypeError, expected: 42 },
    { input: "true", error: TypeError, expected: true },
    { input: '"invalid"', error: TypeError, expected: "invalid" },
  ])(
    "isolates invalid settings $input to the affected scope",
    async ({ input, error, expected }) => {
      const storage = new InspectableSettingsStorage();
      storage.set("global", input);
      storage.set("project", { skills: ["old-skill"] });
      const settingsManager = SettingsManager.fromStorage(storage);

      expect(settingsManager.drainErrors()).toEqual([
        expect.objectContaining({ scope: "global", error: expect.any(error) }),
      ]);
      settingsManager.setDefaultThinkingLevel("high");
      await settingsManager.flush();

      if (error === SyntaxError) {
        expect(() => storage.get("global")).toThrow(SyntaxError);
      } else {
        expect(storage.get("global")).toBe(expected);
      }
      expect(storage.get("project")).toEqual({ skills: ["old-skill"] });
      expect(settingsManager.getProjectSettings()).toEqual({ skills: ["old-skill"] });
    },
  );
});

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

  it("preserves runtime overrides after external project settings reload", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", { compaction: { reserveTokens: 16_384 } });
    storage.set("project", { compaction: { reserveTokens: 20_000 } });
    const settingsManager = SettingsManager.fromStorage(storage);

    settingsManager.applyOverrides({ compaction: { reserveTokens: 50_000 } });
    storage.set("project", {
      compaction: { reserveTokens: 40_000 },
      packages: ["npm:@openclaw/example"],
    });

    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);

    await settingsManager.reload();

    expect(settingsManager.getProjectSettings()).toEqual({
      compaction: { reserveTokens: 40_000 },
      packages: ["npm:@openclaw/example"],
    });
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
  });

  it("recursively merges provider retry overrides", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: {
        provider: { timeoutMs: 30_000, maxRetryDelayMs: 60_000 },
      },
    });

    settingsManager.applyOverrides({
      retry: { provider: { timeoutMs: 45_000 } },
    });

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 45_000,
      maxRetryDelayMs: 60_000,
    });
  });
});
