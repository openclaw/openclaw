// Matrix tests cover completion storage failures during inbound dedupe migration.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPersistentDedupeImportEntry,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  resolveMatrixInboundDedupeStateNamespace,
} from "./src/matrix/monitor/inbound-dedupe.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

function createMigrationParams(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const context: PluginDoctorStateMigrationContext = {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("matrix", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests("matrix", options, entries);
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("matrix", options);
    },
  };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context,
  };
}

function getMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "matrix-inbound-dedupe-to-claimable-dedupe",
  );
  if (!migration) {
    throw new Error("missing Matrix inbound dedupe migration");
  }
  return migration;
}

function writeLegacyDedupeSource(stateDir: string, now: number, withMetadata = false) {
  const root = path.join(
    stateDir,
    "matrix",
    "accounts",
    "home",
    "matrix.example.org__bot",
    "0123456789abcdef",
  );
  fs.mkdirSync(root, { recursive: true });
  const jsonPath = path.join(root, "inbound-dedupe.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      version: 1,
      entries: [{ key: "!room:example.org|$legacy", ts: now - 60_000 }],
    }),
  );
  if (withMetadata) {
    fs.writeFileSync(
      path.join(root, "storage-meta.json"),
      JSON.stringify({ accountId: "home", userId: "@home:example.org" }),
    );
  }
  return jsonPath;
}

describe("matrix inbound dedupe migration capacity", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("keeps sources when the completion namespace is full and imports them after capacity frees", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-capacity-");
    const now = Date.now();
    const jsonPath = writeLegacyDedupeSource(stateDir, now, true);
    const params = createMigrationParams(stateDir);
    const dedupeStore = params.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
      namespace: resolveMatrixInboundDedupeStateNamespace(),
      maxEntries: 20_000,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
      env: params.env,
    });
    const canonicalEntry = createPersistentDedupeImportEntry({
      key: "ops\0!room:example.org\0$runtime",
      seenAt: now,
    });
    await dedupeStore.register(canonicalEntry.key, canonicalEntry.value);
    const completionStore = params.context.openPluginStateKeyedStore<{ value: number }>({
      namespace: "inbound-dedupe-migration-state",
      maxEntries: 4,
      overflowPolicy: "reject-new",
      env: params.env,
    });
    for (let index = 0; index < 4; index++) {
      await completionStore.register(`other-migration-${index}`, { value: index });
    }

    const result = await getMigration().migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed reserving Matrix inbound dedupe migration completion:"),
    ]);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(`${jsonPath}.migrated`)).toBe(false);
    await expect(dedupeStore.lookup(canonicalEntry.key)).resolves.toEqual(canonicalEntry.value);
    await expect(completionStore.entries()).resolves.toHaveLength(4);
    await expect(getMigration().detectLegacyState(params)).resolves.not.toBeNull();

    await completionStore.delete("other-migration-0");

    await expect(getMigration().migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the claimable dedupe store (1 of 1 entries)",
        `Archived Matrix inbound dedupe legacy source -> ${jsonPath}.migrated`,
        "Recorded Matrix inbound dedupe migration completion (0 SQLite roots, 1 JSON roots scanned)",
      ],
      warnings: [],
    });
    await expect(dedupeStore.lookup(canonicalEntry.key)).resolves.toEqual(canonicalEntry.value);
    const legacyEntry = createPersistentDedupeImportEntry({
      key: "home\0!room:example.org\0$legacy",
      seenAt: now - 60_000,
    });
    await expect(dedupeStore.lookup(legacyEntry.key)).resolves.toEqual(legacyEntry.value);
    expect(getPluginStateCapacityForTests("matrix", params.env)).toEqual({
      liveEntries: 6,
      maxEntries: Number.POSITIVE_INFINITY,
    });
    await expect(getMigration().detectLegacyState(params)).resolves.toBeNull();
  });
});
