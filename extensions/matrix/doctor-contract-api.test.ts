import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPersistentDedupeImportEntry,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  readMatrixIdbSnapshotJson,
  writeMatrixIdbSnapshotJson,
} from "./src/matrix/crypto-state-store.js";
import { importNewestInboundDedupeMarkers } from "./src/matrix/monitor/inbound-dedupe-migration.js";
import {
  createMatrixInboundEventDeduper,
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  resolveMatrixInboundDedupeStateNamespace,
} from "./src/matrix/monitor/inbound-dedupe.js";
import { restoreIdbFromDisk } from "./src/matrix/sdk/idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
} from "./src/matrix/sdk/idb-persistence.test-helpers.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const DOCTOR_IDB_DATABASE_PREFIX = "openclaw-matrix-doctor-test";

function createContext(env?: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("matrix", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests("matrix", options, entries);
    },
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
}

function createMigrationParams(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(env),
  };
}

function accountStorageRoot(stateDir: string, accountId = "default", token = "0123456789abcdef") {
  return path.join(stateDir, "matrix", "accounts", accountId, "matrix.example.org__bot", token);
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
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

describe("matrix doctor contract state migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      cleanup();
    }),
  );

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(async () => {
    await clearAllIndexedDbState({ databasePrefix: DOCTOR_IDB_DATABASE_PREFIX });
    vi.restoreAllMocks();
  });

  it("migrates legacy sync cache JSON to SQLite plugin state", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = accountStorageRoot(stateDir);
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "bot-storage.json"),
      JSON.stringify({
        version: 1,
        savedSync: {
          nextBatch: "legacy-token",
          accountData: [],
          roomsData: {
            join: {},
            invite: {},
            leave: {},
            knock: {},
          },
        },
        cleanShutdown: true,
      }),
    );

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix sync cache JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix sync cache legacy source -> ${path.join(storageRootDir, "bot-storage.json")}.migrated`,
      ],
      warnings: [],
    });

    const store = await SqliteBackedMatrixSyncStore.create(storageRootDir);
    expect(store.hasSavedSync()).toBe(true);
    expect(store.hasSavedSyncFromCleanShutdown()).toBe(true);
    await expect(store.getSavedSyncToken()).resolves.toBe("legacy-token");
    const sourcePath = path.join(storageRootDir, "bot-storage.json");
    const archivePath = `${sourcePath}.migrated`;
    expect(fs.existsSync(sourcePath)).toBe(false);

    fs.copyFileSync(archivePath, sourcePath);
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [`Removed already-archived Matrix sync cache legacy source ${sourcePath}`],
      warnings: [],
      notices: [
        `Kept existing Matrix sync cache in SQLite and archived the legacy source for ${storageRootDir}`,
      ],
    });

    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        version: 1,
        savedSync: {
          nextBatch: "newer-legacy-token",
          accountData: [],
          roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
        },
        cleanShutdown: true,
      }),
    );
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [`Archived Matrix sync cache legacy source -> ${sourcePath}.migrated.2`],
      warnings: [],
      notices: [
        `Kept existing Matrix sync cache in SQLite and archived the legacy source for ${storageRootDir}`,
      ],
    });
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    fs.writeFileSync(sourcePath, `${fs.readFileSync(`${sourcePath}.migrated.2`, "utf8")} `, "utf8");
    fs.mkdirSync(`${sourcePath}.migrated.3`);
    const failedArchive = await migration.migrateLegacyState(createMigrationParams(stateDir));
    expect(failedArchive.changes).toEqual([]);
    expect(failedArchive.warnings).toEqual([
      expect.stringContaining("Failed archiving Matrix sync cache legacy source"),
    ]);
    expect(failedArchive.notices).toBeUndefined();
  });

  it("does not archive the legacy flat sync cache into an unread SQLite root", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const flatRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(flatRoot, { recursive: true });
    fs.writeFileSync(
      path.join(flatRoot, "bot-storage.json"),
      JSON.stringify({
        next_batch: "flat-token",
        rooms: { join: {} },
        account_data: { events: [] },
      }),
    );

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toBeNull();
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(fs.existsSync(path.join(flatRoot, "bot-storage.json"))).toBe(true);
  });

  it("restores the supported Matrix crypto snapshot from SQLite", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = path.join(stateDir, "matrix");
    fs.mkdirSync(storageRootDir, { recursive: true });
    const snapshotPath = path.join(storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
    const snapshotDatabaseName = `${DOCTOR_IDB_DATABASE_PREFIX}::matrix-sdk-crypto`;
    const snapshot = [
      {
        name: snapshotDatabaseName,
        version: 1,
        stores: [
          {
            name: "sessions",
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            records: [{ key: "room-1", value: { session: "abc123" } }],
          },
        ],
      },
    ];
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      snapshotJson: JSON.stringify(snapshot),
      databaseCount: snapshot.length,
    });
    expect(JSON.parse((await readMatrixIdbSnapshotJson(storageRootDir)) ?? "null")).toEqual(
      snapshot,
    );
    expect(fs.existsSync(snapshotPath)).toBe(false);

    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({
        name: snapshotDatabaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "abc123" } }]);
  });

  it("detects, imports, and retires schema-v1 inbound dedupe rows without upgrading the source", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const sqliteRoot = accountStorageRoot(stateDir, "ops");
    const homeRoot = accountStorageRoot(stateDir, "home", "fedcba9876543210");
    fs.mkdirSync(sqliteRoot, { recursive: true });
    const roomId = "!room:example.org";
    const now = Date.now();
    const legacyKey = (accountId: string, eventId: string) =>
      `${accountId}:${createHash("sha256")
        .update(accountId)
        .update("\0")
        .update(roomId)
        .update("\0")
        .update(eventId)
        .digest("hex")}`;

    // July shape in a historical schema-v1 database. It intentionally has
    // none of the current schema's migration/audit tables.
    const legacyDatabasePath = path.join(sqliteRoot, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(legacyDatabasePath), { recursive: true });
    const legacyDb = new DatabaseSync(legacyDatabasePath);
    try {
      legacyDb.exec(`
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
      const insert = legacyDb.prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "matrix",
        "inbound-dedupe",
        legacyKey("ops", "$committed"),
        JSON.stringify({ roomId, eventId: "$committed", ts: now - 60_000 }),
        1,
        now + 60_000,
      );
      insert.run(
        "matrix",
        "inbound-dedupe",
        legacyKey("ops", "$stale"),
        JSON.stringify({
          roomId,
          eventId: "$stale",
          ts: now - 31 * 24 * 60 * 60 * 1000,
        }),
        2,
        null,
      );
      insert.run(
        "matrix",
        "inbound-dedupe",
        legacyKey("ops", "$expired-corrupt"),
        "not-json",
        3,
        now - 1,
      );
      insert.run(
        "matrix",
        "inbound-dedupe-migrations",
        "ops:legacy-json-marker",
        JSON.stringify({ importedAt: now }),
        4,
        now + 60_000,
      );
      insert.run("matrix", "credentials", "keep-matrix", '{"keep":true}', 5, null);
      insert.run("other-plugin", "inbound-dedupe", "keep-other", '{"keep":true}', 6, null);
    } finally {
      legacyDb.close();
    }

    writeSqliteDedupeSource(homeRoot, "home", "$home-committed", now - 60_000);

    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    const detectParams = createMigrationParams(stateDir);
    await expect(migration.detectLegacyState(detectParams)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
    const detectedDb = new DatabaseSync(legacyDatabasePath, { readOnly: true });
    try {
      expect(detectedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        detectedDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all(),
      ).toEqual([{ name: "plugin_state_entries" }]);
    } finally {
      detectedDb.close();
    }

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the claimable dedupe store (2 of 3 entries)",
        `Retired Matrix inbound dedupe rows for ${homeRoot}`,
        `Retired Matrix inbound dedupe rows for ${sqliteRoot}`,
        "Recorded Matrix inbound dedupe migration completion (2 SQLite roots scanned)",
      ],
      warnings: [],
    });

    // Pre-upgrade markers must keep deduping through the new runtime guard.
    const dedupeEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const opsDeduper = createMatrixInboundEventDeduper({
      auth: { accountId: "ops" },
      env: dedupeEnv,
    });
    await expect(opsDeduper.claim({ roomId, eventId: "$committed" })).resolves.toEqual({
      kind: "duplicate",
    });
    const staleClaim = await opsDeduper.claim({ roomId, eventId: "$stale" });
    expect(staleClaim.kind).toBe("claimed");
    if (staleClaim.kind === "claimed") {
      staleClaim.handle.release();
    }
    const homeDeduper = createMatrixInboundEventDeduper({
      auth: { accountId: "home" },
      env: dedupeEnv,
    });
    await expect(homeDeduper.claim({ roomId, eventId: "$home-committed" })).resolves.toEqual({
      kind: "duplicate",
    });

    // Only the two retired Matrix namespaces are deleted. The source remains
    // schema v1, with unrelated Matrix and other-plugin state untouched.
    const retiredDb = new DatabaseSync(legacyDatabasePath, { readOnly: true });
    try {
      expect(retiredDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        retiredDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all(),
      ).toEqual([{ name: "plugin_state_entries" }]);
      expect(
        retiredDb
          .prepare(
            `SELECT plugin_id, namespace, entry_key, value_json
             FROM plugin_state_entries
             ORDER BY plugin_id ASC, namespace ASC, entry_key ASC`,
          )
          .all(),
      ).toEqual([
        {
          plugin_id: "matrix",
          namespace: "credentials",
          entry_key: "keep-matrix",
          value_json: '{"keep":true}',
        },
        {
          plugin_id: "other-plugin",
          namespace: "inbound-dedupe",
          entry_key: "keep-other",
          value_json: '{"keep":true}',
        },
      ]);
    } finally {
      retiredDb.close();
    }
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toBeNull();
  });

  it("records an empty configured Matrix scan silently and then skips historical databases", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    const params = createMigrationParams(stateDir);
    params.config = { channels: { matrix: {} } };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
    // Fresh installs scan nothing: the durable receipt is recorded (proven by
    // the historical-database skip below) without a user-visible change line.
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    const lateDatabasePath = path.join(
      stateDir,
      "matrix",
      "accounts",
      "late",
      "matrix.example.org__bot",
      "0123456789abcdef",
      "state",
      "openclaw.sqlite",
    );
    fs.mkdirSync(path.dirname(lateDatabasePath), { recursive: true });
    fs.writeFileSync(lateDatabasePath, "the completed migration must not open this database");
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("withholds completion after a directory read failure and imports the source on retry", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const blockedDir = path.join(stateDir, "matrix", "accounts", "home");
    const storageRootDir = path.join(blockedDir, "matrix.example.org__bot", "0123456789abcdef");
    const roomId = "!room:example.org";
    const eventId = "$found-on-retry";
    writeSqliteDedupeSource(storageRootDir, "home", eventId, Date.now() - 60_000);

    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    const readdirSpy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(blockedDir)) {
        throw Object.assign(new Error("injected directory read failure"), { code: "EACCES" });
      }
      return originalReaddir(...args);
    });
    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    const params = createMigrationParams(stateDir);

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [
        `Failed scanning Matrix inbound dedupe sources under ${blockedDir}: Error: injected directory read failure`,
      ],
    });
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });

    readdirSpy.mockRestore();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the claimable dedupe store (1 of 1 entries)",
        `Retired Matrix inbound dedupe rows for ${storageRootDir}`,
        "Recorded Matrix inbound dedupe migration completion (1 SQLite roots scanned)",
      ],
      warnings: [],
    });
    const deduper = createMatrixInboundEventDeduper({
      auth: { accountId: "home" },
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await expect(deduper.claim({ roomId, eventId })).resolves.toEqual({ kind: "duplicate" });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  });

  it("ignores an invalid legacy-scan completion receipt", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const params = createMigrationParams(stateDir);
    params.config = { channels: { matrix: {} } };
    const receiptStore = params.context.openPluginStateKeyedStore<{
      version: number;
      completedAt: number;
    }>({
      namespace: "inbound-dedupe-migration-state",
      maxEntries: 4,
      overflowPolicy: "reject-new",
      env: params.env,
    });
    await receiptStore.register("sqlite-json-to-claimable-v1", {
      version: 1,
      completedAt: -1,
    });

    await expect(
      migrationById("matrix-inbound-dedupe-to-claimable-dedupe").detectLegacyState(params),
    ).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
  });

  it.each(["not-json", '{"version":1,"entries":[]}'])(
    "refuses retired inbound dedupe JSON without changing bytes or recording completion: %s",
    async (source) => {
      const stateDir = tempDirs.make("openclaw-matrix-doctor-");
      const storageRootDir = accountStorageRoot(stateDir, "home");
      fs.mkdirSync(storageRootDir, { recursive: true });
      const jsonPath = path.join(storageRootDir, "inbound-dedupe.json");
      fs.writeFileSync(jsonPath, source);
      const params = createMigrationParams(stateDir);
      const openStore = vi.spyOn(params.context, "openPluginStateKeyedStore");
      const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");

      for (const run of [migration.detectLegacyState, migration.migrateLegacyState]) {
        await expect(run(params)).rejects.toThrow("Install OpenClaw 2026.9.5");
      }
      expect(openStore).not.toHaveBeenCalled();
      expect(fs.readFileSync(jsonPath, "utf8")).toBe(source);
      expect(fs.existsSync(`${jsonPath}.migrated`)).toBe(false);
    },
  );

  it("keeps inbound dedupe sources when retention-aware import is unavailable", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = accountStorageRoot(stateDir, "home");
    const databasePath = writeSqliteDedupeSource(
      storageRootDir,
      "home",
      "$legacy",
      Date.now() - 60_000,
    );
    const sourceBytes = fs.readFileSync(databasePath);
    const params = createMigrationParams(stateDir);
    delete params.context.importPluginStateEntries;
    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [
        "Failed importing Matrix inbound dedupe markers: Error: retention-aware Matrix inbound dedupe import is unavailable; left legacy sources in place",
      ],
    });
    expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
  });

  it("keeps newer runtime dedupe rows when legacy imports hit capacity", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const io = { context: createContext(env), env };
    const roomId = "!room:example.org";
    const now = Date.now();
    const store = createPluginStateKeyedStoreForTests<PersistentDedupeEntry>("matrix", {
      namespace: resolveMatrixInboundDedupeStateNamespace(),
      maxEntries: 3,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
      env: io.env,
    });
    const runtimeEntry = createPersistentDedupeImportEntry({
      key: `ops\0${roomId}\0$runtime`,
      seenAt: now,
    });
    await store.register(runtimeEntry.key, runtimeEntry.value);

    // Both legacy rows fit, but retain their source age below the runtime row.
    await expect(
      importNewestInboundDedupeMarkers({
        io,
        now,
        stateMaxEntries: 3,
        markers: [
          { accountId: "ops", roomId, eventId: "$old", ts: now - 60_000 },
          { accountId: "ops", roomId, eventId: "$newer", ts: now - 30_000 },
        ],
      }),
    ).resolves.toEqual({ imported: 2, total: 2 });

    // The next runtime-equivalent insert evicts the oldest legacy row, not the
    // newer legacy marker or the row committed after upgrade.
    const nextRuntimeEntry = createPersistentDedupeImportEntry({
      key: `ops\0${roomId}\0$next-runtime`,
      seenAt: now + 1,
    });
    await store.register(nextRuntimeEntry.key, nextRuntimeEntry.value);
    const keys = (await store.entries()).map((entry) => entry.value.key).toSorted();
    expect(keys).toEqual(
      [
        `ops\0${roomId}\0$newer`,
        `ops\0${roomId}\0$runtime`,
        `ops\0${roomId}\0$next-runtime`,
      ].toSorted(),
    );
  });

  it("preserves a legacy inbound dedupe marker's remaining TTL", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const io = { context: createContext(env), env };
    const now = 2_000_000_000_000;
    const remainingTtlMs = 1_000;
    const roomId = "!room:example.org";
    const eventId = "$near-expiry";
    const key = `ops\0${roomId}\0${eventId}`;
    const markerTs = now - MATRIX_INBOUND_DEDUPE_TTL_MS + remainingTtlMs;
    const storedEntry = createPersistentDedupeImportEntry({ key, seenAt: markerTs });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(
      importNewestInboundDedupeMarkers({
        io,
        now,
        markers: [
          {
            accountId: "ops",
            roomId,
            eventId,
            ts: markerTs,
          },
        ],
      }),
    ).resolves.toEqual({ imported: 1, total: 1 });

    const store = createPluginStateKeyedStoreForTests<PersistentDedupeEntry>("matrix", {
      namespace: resolveMatrixInboundDedupeStateNamespace(),
      maxEntries: 20_000,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
      env,
    });
    const importedEntry = (await store.entries()).find((entry) => entry.key === storedEntry.key);
    expect(importedEntry).toMatchObject({
      createdAt: markerTs,
      expiresAt: now + remainingTtlMs,
      value: storedEntry.value,
    });
    nowSpy.mockRestore();
    await expect(store.lookup(storedEntry.key)).resolves.toEqual(storedEntry.value);

    // Preserve the imported deadline above, then seed expiry visible to the worker clock.
    const { db } = openOpenClawStateDatabase({ env });
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabaseForTests, "plugin_state_entries">>(db)
        .updateTable("plugin_state_entries")
        .set({ expires_at: 1 })
        .where("plugin_id", "=", "matrix")
        .where("namespace", "=", resolveMatrixInboundDedupeStateNamespace())
        .where("entry_key", "=", storedEntry.key),
    );
    await expect(store.lookup(storedEntry.key)).resolves.toBeUndefined();
  });
});
