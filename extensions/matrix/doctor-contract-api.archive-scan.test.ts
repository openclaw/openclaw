// Matrix tests cover bounded doctor state-root discovery.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { createMatrixInboundEventDeduper } from "./src/matrix/monitor/inbound-dedupe.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

function createMigrationParams(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const context: PluginDoctorStateMigrationContext = {
    getPluginStateCapacity: () => getPluginStateCapacityForTests("matrix", env),
    importPluginStateEntries: (options, entries) =>
      importPluginStateEntriesForDoctorForTests("matrix", options, entries),
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context,
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

function writeLegacySyncCache(storageRootDir: string, nextBatch: string): void {
  fs.mkdirSync(storageRootDir, { recursive: true });
  fs.writeFileSync(
    path.join(storageRootDir, "bot-storage.json"),
    JSON.stringify({
      version: 1,
      savedSync: {
        nextBatch,
        accountData: [],
        roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
      },
      cleanShutdown: true,
    }),
  );
}

function writeSqliteDedupeSource(
  storageRootDir: string,
  accountId: string,
  eventId: string,
  ts: number,
): string {
  const databasePath = path.join(storageRootDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const roomId = "!room:example.org";
  const key = `${accountId}:${createHash("sha256")
    .update(`${accountId}\0${roomId}\0${eventId}`)
    .digest("hex")}`;
  const db = new DatabaseSync(databasePath);
  try {
    // July's per-account store used this row shape and schema version.
    db.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    db.prepare(`
      INSERT INTO plugin_state_entries VALUES ('matrix', 'inbound-dedupe', ?, ?, ?, NULL)
    `).run(key, JSON.stringify({ roomId, eventId, ts }), ts);
  } finally {
    db.close();
  }
  return databasePath;
}

function createStateRoots(stateDir: string) {
  const matrixRoot = path.join(stateDir, "matrix");
  const tokenParent = path.join(matrixRoot, "accounts", "ops", "matrix.example.org__bot");
  return {
    activeRoots: [
      path.join(matrixRoot, "accounts", "legacy"),
      path.join(
        matrixRoot,
        "accounts",
        "sync-cache-backup",
        "matrix.example.org__bot",
        "0123456789abcdef",
      ),
    ],
    excludedRoots: [
      "0123456789abcdef.apr24-cutover-20260424",
      "fedcba9876543210.reset-20260720",
      "0123456789abcdef.pre-stable-token-20260716",
      "fedcba9876543210.migrated",
      "sync-cache-backup",
      "_archive",
    ]
      .map((name) => path.join(tokenParent, name))
      .concat(
        ["crypto-backup-20260720", ".apr24-cutover-20260424", "operator-copy"].map((name) =>
          path.join(
            matrixRoot,
            name,
            "accounts",
            "ops",
            "matrix.example.org__bot",
            "fedcba9876543210",
          ),
        ),
      ),
  };
}

function trackVisitedDirectories(): string[] {
  const visitedDirs: string[] = [];
  const originalReaddir = fsPromises.readdir.bind(fsPromises);
  vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
    visitedDirs.push(path.resolve(String(args[0])));
    return originalReaddir(...args);
  });
  return visitedDirs;
}

function expectRootNotVisited(visitedDirs: string[], storageRootDir: string): void {
  const root = path.resolve(storageRootDir);
  expect(
    visitedDirs.some(
      (visitedDir) => visitedDir === root || visitedDir.startsWith(`${root}${path.sep}`),
    ),
  ).toBe(false);
}

describe("matrix doctor archive scan boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it("keeps archive-like account IDs active while excluding token-root archives", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const { activeRoots, excludedRoots } = createStateRoots(stateDir);
    for (const [index, storageRootDir] of [...activeRoots, ...excludedRoots].entries()) {
      writeLegacySyncCache(storageRootDir, `legacy-token-${index}`);
    }

    const visitedDirs = trackVisitedDirectories();

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: activeRoots.map(
        (storageRootDir) => `Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`,
      ),
    });
    const result = await migration.migrateLegacyState(createMigrationParams(stateDir));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(activeRoots.length * 2);
    for (const [index, storageRootDir] of activeRoots.entries()) {
      const store = await SqliteBackedMatrixSyncStore.create(storageRootDir);
      await expect(store.getSavedSyncToken()).resolves.toBe(`legacy-token-${index}`);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(false);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json.migrated"))).toBe(true);
    }
    for (const storageRootDir of excludedRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(true);
      expectRootNotVisited(visitedDirs, storageRootDir);
    }
  });

  it("imports dedupe state for archive-like account IDs without opening token archives", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const { activeRoots, excludedRoots } = createStateRoots(stateDir);
    const now = Date.now();
    for (const [index, storageRootDir] of activeRoots.entries()) {
      writeSqliteDedupeSource(
        storageRootDir,
        index === 0 ? "sync-cache-backup" : "legacy",
        `$active-${index}`,
        now - 60_000,
      );
    }
    for (const storageRootDir of excludedRoots) {
      fs.mkdirSync(path.join(storageRootDir, "state"), { recursive: true });
      fs.writeFileSync(
        path.join(storageRootDir, "state", "openclaw.sqlite"),
        "archived SQLite sentinel must not be opened",
      );
      fs.writeFileSync(
        path.join(storageRootDir, "inbound-dedupe.json"),
        JSON.stringify({
          version: 1,
          entries: [{ key: "!room:example.org|$archived", ts: now - 60_000 }],
        }),
      );
    }

    const visitedDirs = trackVisitedDirectories();

    const result = await migrationById(
      "matrix-inbound-dedupe-to-claimable-dedupe",
    ).migrateLegacyState(createMigrationParams(stateDir));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Matrix inbound dedupe markers to the claimable dedupe store (2 of 2 entries)",
      ...activeRoots.map(
        (storageRootDir) => `Retired Matrix inbound dedupe rows for ${storageRootDir}`,
      ),
      "Recorded Matrix inbound dedupe migration completion (2 SQLite roots scanned)",
    ]);
    for (const [index, accountId] of ["sync-cache-backup", "legacy"].entries()) {
      const deduper = createMatrixInboundEventDeduper({
        auth: { accountId },
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      await expect(
        deduper.claim({ roomId: "!room:example.org", eventId: `$active-${index}` }),
      ).resolves.toEqual({ kind: "duplicate" });
    }
    for (const storageRootDir of excludedRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "inbound-dedupe.json"))).toBe(true);
      expect(fs.readFileSync(path.join(storageRootDir, "state", "openclaw.sqlite"), "utf8")).toBe(
        "archived SQLite sentinel must not be opened",
      );
      expectRootNotVisited(visitedDirs, storageRootDir);
    }
  });
});
