import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each([
  { index: 0, namespace: "bus-state" },
  { index: 1, namespace: "profile-state" },
])("retired Nostr $namespace import", ({ index, namespace }) => {
  it("leaves old files untouched and directs their owner through the bridge release", async () => {
    const stateDir = tempDirs.make("openclaw-nostr-doctor-");
    const params = {
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: {
        openPluginStateKeyedStore: () => {
          throw new Error("Retired imports must not access plugin state");
        },
      },
    };
    const migration = expectDefined(stateMigrations[index], "Nostr migration");
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    const nostrDir = path.join(stateDir, "nostr");
    const sourceName = `${namespace}-main.json`;
    const sourcePath = path.join(nostrDir, sourceName);
    const source = "unparsed legacy bytes\n";
    await fs.mkdir(nostrDir);
    await fs.writeFile(sourcePath, source);

    expect(await migration.detectLegacyState(params)).not.toBeNull();
    expect(await migration.migrateLegacyState(params)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("2026.9.5")],
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readdir(nostrDir)).resolves.toEqual([sourceName]);

    await fs.rename(sourcePath, `${sourcePath}.migrated`);
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  });
});
