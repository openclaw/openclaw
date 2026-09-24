import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("removes the retired QMD override while preserving Active Memory siblings", () => {
  expect(legacyConfigRules).toEqual([
    expect.objectContaining({
      path: ["plugins", "entries", "active-memory", "config", "qmd"],
      message: expect.stringContaining("doctor --fix"),
    }),
  ]);
  const cfg = {
    plugins: {
      entries: {
        "active-memory": {
          config: { enabled: true, qmd: { searchMode: "search" } },
        },
      },
    },
  };

  const result = normalizeCompatibilityConfig({ cfg });

  expect(result.config).toHaveProperty("plugins.entries.active-memory.config.enabled", true);
  expect(result.config).not.toHaveProperty("plugins.entries.active-memory.config.qmd");
  expect(result.changes).toEqual(["Removed retired Active Memory QMD search-mode configuration."]);
});

it("preserves retired opt-outs and directs their owner through the bridge release", async () => {
  const stateDir = tempDirs.make("openclaw-active-memory-retired-");
  const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
  const source = '{"sessions":{"telegram:dm:123":{"disabled":true,"updatedAt":1700}}}';
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("Retired toggles must not open plugin state");
  });
  const params = {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  const migration = stateMigrations[0]!;
  await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, source);

  const detected = await migration.detectLegacyState(params);
  expect(detected?.preview).toEqual([expect.stringContaining("2026.9.5")]);
  await expect(migration.migrateLegacyState(params)).resolves.toEqual({
    changes: [],
    warnings: detected?.preview,
  });
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
  await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
  await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();

  await fs.rm(sourcePath);
  await expect(migration.detectLegacyState(params)).resolves.toBeNull();
});
