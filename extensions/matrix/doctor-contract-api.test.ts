import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPersistentDedupeImportEntry,
  resolvePersistentDedupePluginStateNamespace,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  createChannelIngressQueueForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  migrationById,
  writeLegacySyncCache,
  writeSqliteDedupeSource,
} from "./doctor-contract-api.test-support.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  matrixCredentialsStoreKey,
  type MatrixCredentialStateRecord,
  type MatrixStoredCredentialRecord,
} from "./src/matrix/credentials-state.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  readMatrixIdbSnapshotJson,
  writeMatrixIdbSnapshotJson,
} from "./src/matrix/crypto-state-store.js";
import {
  importInboundDedupeMarkersToIngress,
  MATRIX_INBOUND_DEDUPE_TTL_MS,
} from "./src/matrix/monitor/inbound-dedupe-migration.js";
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
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", { ...options, env: options.env ?? env }),
    readPluginStateEntriesInKeyRange(namespace, range) {
      return createPluginStateSyncKeyedStoreForTests<unknown>("matrix", {
        namespace,
        maxEntries: 20_000,
        defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
        env,
      })
        .entries()
        .filter(
          (entry) =>
            entry.key.startsWith(range.prefix) && (!range.after || entry.key > range.after),
        )
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .slice(0, range.limit)
        .map((entry) =>
          Object.assign(entry, {
            valueJson: JSON.stringify(entry.value),
            expiresAt: entry.expiresAt ?? null,
          }),
        );
    },
    channelIngressQueues: [
      {
        channelId: "matrix",
        listChannelIngressQueueAccountIds: async () => [],
        openChannelIngressQueueForInspection: <TPayload, TMetadata>({
          accountId,
        }: { accountId?: string } = {}) =>
          createChannelIngressQueueForTests<TPayload, TMetadata>({
            channelId: "matrix",
            accountId,
            stateDir: env?.OPENCLAW_STATE_DIR,
          }),
        openChannelIngressQueue: <TPayload, TMetadata, TCompletedMetadata>({
          accountId,
        }: { accountId?: string } = {}) =>
          createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
            channelId: "matrix",
            accountId,
            stateDir: env?.OPENCLAW_STATE_DIR,
          }),
      },
    ],
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

  it("reports crypto refusal in Doctor without auto-clearing it", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = accountStorageRoot(stateDir);
    fs.mkdirSync(storageRootDir, { recursive: true });
    const markerPath = path.join(storageRootDir, `${MATRIX_IDB_SNAPSHOT_FILENAME}.owner.poisoned`);
    fs.writeFileSync(markerPath, "unsafe\n");
    const migration = migrationById("matrix-crypto-unsafe-state");
    expect((await migration.detectLegacyState(createMigrationParams(stateDir)))?.preview).toEqual([
      expect.stringContaining("recovery is never automatic"),
    ]);
    const result = await migration.migrateLegacyState(createMigrationParams(stateDir));
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("remains blocked")]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("migrates legacy sync cache JSON to SQLite plugin state", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = accountStorageRoot(stateDir);
    writeLegacySyncCache(storageRootDir, "legacy-token");

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

    writeLegacySyncCache(storageRootDir, "newer-legacy-token");
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
        "Migrated Matrix inbound dedupe markers to the durable ingress spool (2 of 3 entries)",
        `Retired Matrix inbound dedupe rows for ${homeRoot}`,
        `Retired Matrix inbound dedupe rows for ${sqliteRoot}`,
        "Recorded Matrix inbound dedupe migration completion (2 SQLite roots scanned)",
      ],
      warnings: [],
    });

    // Previously committed identities must reject transport replay after upgrade.
    const opsQueue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "ops",
      stateDir,
    });
    await expect(opsQueue.enqueue("$committed", {})).resolves.toMatchObject({ kind: "completed" });
    await expect(opsQueue.enqueue("$stale", {})).resolves.toMatchObject({ kind: "accepted" });
    const homeQueue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "home",
      stateDir,
    });
    await expect(homeQueue.enqueue("$home-committed", {})).resolves.toMatchObject({
      kind: "completed",
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

  it("does not require inbound dedupe migration for a fresh runtime account root", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const storageRootDir = accountStorageRoot(stateDir);
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      snapshotJson: "[]",
      databaseCount: 0,
    });
    await closeOpenClawStateDatabaseAsync();

    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    const params = createMigrationParams(stateDir);
    params.config = { channels: { matrix: {} } };
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    writeSqliteDedupeSource(accountStorageRoot(stateDir, "legacy"), "legacy", "$old", Date.now());
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
  });

  it("allows an empty configured Matrix scan and then skips completed historical databases", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    const params = createMigrationParams(stateDir);
    params.config = { channels: { matrix: {} } };

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
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
        "Migrated Matrix inbound dedupe markers to the durable ingress spool (1 of 1 entries)",
        `Retired Matrix inbound dedupe rows for ${storageRootDir}`,
        "Recorded Matrix inbound dedupe migration completion (1 SQLite roots scanned)",
      ],
      warnings: [],
    });
    const queue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "home",
      stateDir,
    });
    await expect(queue.enqueue(eventId, {})).resolves.toMatchObject({ kind: "completed" });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  });

  it("refuses retired inbound dedupe JSON without changing bytes or recording completion", async () => {
    const source = "not-json";
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
  });

  it("keeps inbound dedupe sources when ingress import is unavailable", async () => {
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
    delete params.context.channelIngressQueues;
    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [
        "Failed importing Matrix inbound dedupe markers: Error: Matrix ingress migration requires the host-owned ingress queue; left legacy sources in place",
      ],
    });
    expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
    });
  });

  it("preserves a legacy marker's remaining ingress tombstone retention", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const now = Date.now();
    const markerTs = now - MATRIX_INBOUND_DEDUPE_TTL_MS + 1_000;
    await expect(
      importInboundDedupeMarkersToIngress({
        context: createContext(env),
        now,
        markers: [
          { accountId: "ops", roomId: "!room:example.org", eventId: "$near-expiry", ts: markerTs },
        ],
      }),
    ).resolves.toEqual({ imported: 1, total: 1 });
    const queue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "ops",
      stateDir,
    });
    await expect(queue.enqueue("$near-expiry", {})).resolves.toMatchObject({
      kind: "completed",
      record: { completedAt: markerTs },
    });
    await expect(queue.prune({ completedTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS, now })).resolves.toBe(
      0,
    );
    await expect(
      queue.prune({ completedTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS, now: now + 1_001 }),
    ).resolves.toBe(1);
    await expect(queue.enqueue("$near-expiry", {})).resolves.toMatchObject({ kind: "accepted" });
  });

  it("keeps sources when the completion namespace is full and imports them after capacity frees", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-capacity-");
    const now = Date.now();
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "home",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    const databasePath = writeSqliteDedupeSource(storageRootDir, "home", "$legacy", now - 60_000);
    const sourceBytes = fs.readFileSync(databasePath);
    const params = createMigrationParams(stateDir);
    const completionStore = params.context.openPluginStateKeyedStore<{ value: number }>({
      namespace: "inbound-dedupe-migration-state",
      maxEntries: 4,
      overflowPolicy: "reject-new",
      env: params.env,
    });
    for (let index = 0; index < 4; index++) {
      await completionStore.register(`other-migration-${index}`, { value: index });
    }

    const result = await migrationById(
      "matrix-inbound-dedupe-to-claimable-dedupe",
    ).migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed reserving Matrix inbound dedupe migration completion:"),
    ]);
    expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
    await expect(completionStore.entries()).resolves.toHaveLength(4);
    await expect(
      migrationById("matrix-inbound-dedupe-to-claimable-dedupe").detectLegacyState(params),
    ).resolves.not.toBeNull();

    await completionStore.delete("other-migration-0");

    await expect(
      migrationById("matrix-inbound-dedupe-to-claimable-dedupe").migrateLegacyState(params),
    ).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the durable ingress spool (1 of 1 entries)",
        `Retired Matrix inbound dedupe rows for ${storageRootDir}`,
        "Recorded Matrix inbound dedupe migration completion (1 SQLite roots scanned)",
      ],
      warnings: [],
    });
    const queue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "home",
      stateDir,
    });
    await expect(queue.enqueue("$legacy", {})).resolves.toMatchObject({ kind: "completed" });
    await expect(
      migrationById("matrix-inbound-dedupe-to-claimable-dedupe").detectLegacyState(params),
    ).resolves.toBeNull();
  });

  it("moves current replay markers to account-scoped ingress after the historical migration completed", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-replay-upgrade-");
    const params = createMigrationParams(stateDir);
    const store = params.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
      namespace: resolvePersistentDedupePluginStateNamespace({
        namespace: "global",
        namespacePrefix: "matrix.inbound-dedupe",
      }),
      maxEntries: 20_000,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
    });
    const seenAt = Date.now() - 60_000;
    for (const accountId of ["ops", "home"]) {
      const entry = createPersistentDedupeImportEntry({
        key: `${accountId}\0!room:example.org\0$already-adopted`,
        seenAt,
      });
      await store.register(entry.key, entry.value);
    }
    await params.context
      .openPluginStateKeyedStore({
        namespace: "inbound-dedupe-migration-state",
        maxEntries: 4,
      })
      .register("sqlite-json-to-claimable-v1", { version: 1, completedAt: seenAt });
    const migration = migrationById("matrix-replay-guard-to-ingress");
    expect(migration.doctorOnly).not.toBe(true);
    expect(await migration.detectLegacyState(params)).not.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(store.entries()).resolves.toEqual([]);
    for (const accountId of ["ops", "home"]) {
      const queue = createChannelIngressQueueForTests({ channelId: "matrix", accountId, stateDir });
      await expect(queue.enqueue("$already-adopted", {})).resolves.toMatchObject({
        kind: "completed",
        record: { completedAt: seenAt },
      });
    }
    expect(await migration.detectLegacyState(params)).toBeNull();
  });

  it("keeps replay markers until every ingress tombstone commits and retries without redelivery", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-replay-retry-");
    const params = createMigrationParams(stateDir);
    const store = params.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
      namespace: resolvePersistentDedupePluginStateNamespace({
        namespace: "global",
        namespacePrefix: "matrix.inbound-dedupe",
      }),
      maxEntries: 20_000,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
    });
    const seenAt = Date.now() - 60_000;
    for (const eventId of ["$first", "$second"]) {
      const entry = createPersistentDedupeImportEntry({
        key: `ops\0!room:example.org\0${eventId}`,
        seenAt,
      });
      await store.register(entry.key, entry.value);
    }
    const access = params.context.channelIngressQueues![0]!;
    const openQueue = access.openChannelIngressQueue!;
    let completed = 0;
    access.openChannelIngressQueue = <TPayload, TMetadata, TCompletedMetadata>(options?: {
      accountId?: string;
    }) => {
      const queue = openQueue<TPayload, TMetadata, TCompletedMetadata>(options);
      const complete = queue.complete.bind(queue);
      queue.complete = async (...args) => {
        if (++completed === 2) {
          throw new Error("injected ingress write failure");
        }
        return complete(...args);
      };
      return queue;
    };
    const migration = migrationById("matrix-replay-guard-to-ingress");
    await expect(migration.migrateLegacyState(params)).rejects.toThrow(
      "injected ingress write failure",
    );
    await expect(store.entries()).resolves.toHaveLength(2);
    access.openChannelIngressQueue = openQueue;
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(store.entries()).resolves.toEqual([]);
    const queue = createChannelIngressQueueForTests({
      channelId: "matrix",
      accountId: "ops",
      stateDir,
    });
    await expect(queue.listPending()).resolves.toEqual([]);
    for (const eventId of ["$first", "$second"]) {
      await expect(queue.enqueue(eventId, {})).resolves.toMatchObject({ kind: "completed" });
    }
  });

  it.each([
    ["credentials-ops.json", [], "ops"],
    ["credentials.json", ["ops"], "ops"],
    ["credentials.json", ["ops", "alerts"], null],
  ] as const)(
    "preserves credential migration for %s with accounts %j",
    async (filename, accountIds, accountId) => {
      const stateDir = tempDirs.make("openclaw-matrix-doctor-");
      const credentialsDir = path.join(stateDir, "credentials", "matrix");
      const filePath = path.join(credentialsDir, filename);
      const credentials = {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "secret-token",
        deviceId: "DEVICE123",
        createdAt: "2026-07-01T12:00:00.000Z",
        lastUsedAt: "2026-07-02T12:00:00.000Z",
      };
      fs.mkdirSync(credentialsDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(credentials));
      const migration = migrationById("matrix-credentials-json-to-plugin-state");
      const params = createMigrationParams(stateDir);
      if (accountIds.length > 0) {
        params.config = {
          channels: {
            matrix: { accounts: Object.fromEntries(accountIds.map((id) => [id, {}])) },
          },
        };
      }

      await expect(migration.detectLegacyState(params)).resolves.toEqual({
        preview: ["Matrix credential JSON can migrate to SQLite (1 file)"],
      });
      const result = await migration.migrateLegacyState(params);

      const store = params.context.openPluginStateKeyedStore<MatrixStoredCredentialRecord>({
        namespace: MATRIX_CREDENTIALS_NAMESPACE,
        maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      if (accountId === null) {
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          `Left ambiguous Matrix credential legacy source in place because no default account is selected: ${filePath}`,
        ]);
        await expect(store.entries()).resolves.toEqual([]);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
        return;
      }
      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Migrated Matrix credentials for account ${accountId} to SQLite`,
        expect.stringContaining("Archived Matrix credentials legacy source"),
      ]);
      await expect(store.lookup(matrixCredentialsStoreKey(accountId))).resolves.toEqual({
        accountId,
        ...credentials,
      });
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    },
  );

  it("retains credential sources when an absent-only import is refused", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const filePath = path.join(stateDir, "credentials", "matrix", "credentials-ops.json");
    const source = JSON.stringify({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "synthetic-token",
      createdAt: "2026-07-01T12:00:00.000Z",
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    const params = createMigrationParams(stateDir);
    const context = params.context;
    params.context = {
      ...context,
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        const store = context.openPluginStateKeyedStore<T>(options);
        return { ...store, registerIfAbsent: async () => false };
      },
    };

    const result = await migrationById(
      "matrix-credentials-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Matrix credentials for account ops"),
    ]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
  });

  it("archives legacy credentials without restoring an explicitly cleared account", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-ops.json");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "legacy-token",
        createdAt: "2026-07-01T12:00:00.000Z",
      }),
    );
    const params = createMigrationParams(stateDir);
    const credentialStore = params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await credentialStore.register(matrixCredentialsStoreKey("ops"), {
      accountId: "ops",
      kind: "revoked",
      revokedAt: "2026-07-02T12:00:00.000Z",
    });

    const result = await migrationById(
      "matrix-credentials-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Archived revoked Matrix credential legacy source for account ops",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("keeps canonical SQLite credentials and archives a differing legacy source", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-agent1.json");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@agent1:example.org",
        accessToken: "legacy-token",
        deviceId: "LEGACYDEVICE",
        createdAt: "2026-07-02T12:00:00.000Z",
      }),
    );
    const params = createMigrationParams(stateDir);
    const credentialStore = params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const canonical: MatrixStoredCredentialRecord = {
      accountId: "agent1",
      homeserver: "https://matrix.example.org",
      userId: "@agent1:example.org",
      accessToken: "canonical-token",
      deviceId: "CANONICALDEVICE",
      createdAt: "2026-07-01T12:00:00.000Z",
    };
    await credentialStore.register(matrixCredentialsStoreKey("agent1"), canonical);

    const result = await migrationById(
      "matrix-credentials-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Kept existing Matrix credentials for account agent1",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    await expect(credentialStore.lookup(matrixCredentialsStoreKey("agent1"))).resolves.toEqual(
      canonical,
    );
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${filePath}.migrated`, "utf8"))).toMatchObject({
      accessToken: "legacy-token",
      deviceId: "LEGACYDEVICE",
    });
  });
});
