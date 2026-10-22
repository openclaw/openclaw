import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  createPersistentDedupeImportEntry,
  resolvePersistentDedupePluginStateNamespace,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createChannelIngressQueueForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  migrationById,
  accountStorageRoot,
  archiveScanRoots,
  createMigrationParams,
  createLegacyDatabase,
  dedupeMigrationResult,
  legacyCredentials,
  withDatabase,
  writeSource,
  writeLegacySyncCache,
  writeSqliteDedupeSource,
} from "./doctor-contract-api.test-support.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  matrixCredentialsStoreKey,
  type MatrixCredentialStateRecord,
} from "./src/matrix/credentials-state.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  writeMatrixIdbSnapshotJson,
} from "./src/matrix/crypto-state-store.js";
import { importInboundDedupeMarkersToIngress } from "./src/matrix/monitor/inbound-dedupe-migration.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const CRYPTO = "matrix-crypto-unsafe-state";
const SYNC = "matrix-sync-cache-json-to-plugin-state";
const DEDUPE = "matrix-inbound-dedupe-to-claimable-dedupe";
const CREDENTIALS = "matrix-credentials-json-to-plugin-state";
const unchanged = { changes: [], warnings: [] };
const pendingDedupe = {
  preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"],
};

const credentialStoreOptions = {
  namespace: MATRIX_CREDENTIALS_NAMESPACE,
  maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
  overflowPolicy: "reject-new",
} as const;

describe("matrix doctor contract state migrations", () => {
  let stateDir: string;
  let params: ReturnType<typeof createMigrationParams>;
  const detect = async (id: string) => (await migrationById(id)).detectLegacyState(params);
  const migrate = async (id: string) => (await migrationById(id)).migrateLegacyState(params);
  const enqueue = (accountId: string, eventId: string) =>
    createChannelIngressQueueForTests({ channelId: "matrix", accountId, stateDir }).enqueue(
      eventId,
      {},
    );
  const openCredentials = () =>
    params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>(credentialStoreOptions);
  const openReplayMarkers = () =>
    params.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
      namespace: resolvePersistentDedupePluginStateNamespace({
        namespace: "global",
        namespacePrefix: "matrix.inbound-dedupe",
      }),
      maxEntries: 20_000,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
    });
  const writeCredentials = (filename: string, credentials: ReturnType<typeof legacyCredentials>) =>
    writeSource(
      path.join(stateDir, "credentials", "matrix", filename),
      JSON.stringify(credentials),
    );
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
    stateDir = tempDirs.make("openclaw-matrix-doctor-");
    params = createMigrationParams(stateDir);
  });

  afterEach(() => vi.restoreAllMocks());

  it("reports crypto refusal in Doctor without auto-clearing it", async () => {
    const storageRootDir = accountStorageRoot(stateDir);
    fs.mkdirSync(storageRootDir, { recursive: true });
    const markerPath = path.join(storageRootDir, `${MATRIX_IDB_SNAPSHOT_FILENAME}.owner.poisoned`);
    fs.writeFileSync(markerPath, "unsafe\n");
    expect((await detect(CRYPTO))?.preview).toEqual([
      expect.stringContaining("recovery is never automatic"),
    ]);
    const result = await migrate(CRYPTO);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("remains blocked")]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it.each(["sync-cache", "inbound-dedupe"] as const)(
    "migrates %s for archive-like account IDs without opening archives",
    async (kind) => {
      params = createMigrationParams(stateDir, false);
      const { activeRoots, excludedRoots } = archiveScanRoots(stateDir);
      const accounts = ["sync-cache-backup", "legacy"];
      const sentinel = "archived SQLite sentinel must not be opened";
      const sync = kind === "sync-cache";
      const filename = sync ? "bot-storage.json" : "inbound-dedupe.json";
      if (sync) {
        [...activeRoots, ...excludedRoots].forEach((root, i) =>
          writeLegacySyncCache(root, `legacy-token-${i}`),
        );
      } else {
        activeRoots.forEach((root, i) =>
          writeSqliteDedupeSource(root, accounts[i]!, `$active-${i}`, Date.now() - 60_000),
        );
        for (const root of excludedRoots) {
          writeSource(path.join(root, "state", "openclaw.sqlite"), sentinel);
          writeSource(path.join(root, filename), "{}");
        }
      }
      const visited: string[] = [];
      const readdir = fsPromises.readdir.bind(fsPromises);
      vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
        visited.push(path.resolve(String(args[0])));
        return readdir(...args);
      });
      const id = sync ? SYNC : DEDUPE;
      if (sync) {
        await expect(detect(id)).resolves.toEqual({
          preview: activeRoots.map(
            (root) => `Matrix sync cache JSON can migrate to SQLite: ${root}`,
          ),
        });
      }
      const result = await migrate(id);
      expect(result.warnings).toEqual([]);
      if (sync) {
        expect(result.changes).toHaveLength(activeRoots.length * 2);
        for (const [i, root] of activeRoots.entries()) {
          const store = await SqliteBackedMatrixSyncStore.create(root);
          await expect(store.getSavedSyncToken()).resolves.toBe(`legacy-token-${i}`);
          expect(fs.existsSync(path.join(root, filename))).toBe(false);
          expect(fs.existsSync(path.join(root, `${filename}.migrated`))).toBe(true);
        }
      } else {
        expect(result.changes).toEqual(dedupeMigrationResult(activeRoots, 2).changes);
        for (const [i, accountId] of accounts.entries()) {
          await expect(enqueue(accountId, `$active-${i}`)).resolves.toMatchObject({
            kind: "completed",
          });
        }
      }
      for (const root of excludedRoots) {
        expect(fs.existsSync(path.join(root, filename))).toBe(true);
        if (!sync) {
          expect(fs.readFileSync(path.join(root, "state", "openclaw.sqlite"), "utf8")).toBe(
            sentinel,
          );
        }
        const resolved = path.resolve(root);
        expect(
          visited.some((dir) => dir === resolved || dir.startsWith(`${resolved}${path.sep}`)),
        ).toBe(false);
      }
    },
  );

  it("migrates legacy sync cache JSON to SQLite plugin state", async () => {
    const storageRootDir = accountStorageRoot(stateDir);
    writeLegacySyncCache(storageRootDir, "legacy-token");

    await expect(detect(SYNC)).resolves.toEqual({
      preview: [`Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migrate(SYNC)).resolves.toEqual({
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
    await expect(migrate(SYNC)).resolves.toEqual({
      changes: [`Removed already-archived Matrix sync cache legacy source ${sourcePath}`],
      warnings: [],
      notices: [
        `Kept existing Matrix sync cache in SQLite and archived the legacy source for ${storageRootDir}`,
      ],
    });

    writeLegacySyncCache(storageRootDir, "newer-legacy-token");
    await expect(migrate(SYNC)).resolves.toEqual({
      changes: [`Archived Matrix sync cache legacy source -> ${sourcePath}.migrated.2`],
      warnings: [],
      notices: [
        `Kept existing Matrix sync cache in SQLite and archived the legacy source for ${storageRootDir}`,
      ],
    });
    await expect(migrate(SYNC)).resolves.toEqual(unchanged);

    fs.writeFileSync(sourcePath, `${fs.readFileSync(`${sourcePath}.migrated.2`, "utf8")} `, "utf8");
    fs.mkdirSync(`${sourcePath}.migrated.3`);
    const failedArchive = await migrate(SYNC);
    expect(failedArchive.changes).toEqual([]);
    expect(failedArchive.warnings).toEqual([
      expect.stringContaining("Failed archiving Matrix sync cache legacy source"),
    ]);
    expect(failedArchive.notices).toBeUndefined();
  });

  it("detects, imports, and retires schema-v1 inbound dedupe rows without upgrading the source", async () => {
    const sqliteRoot = accountStorageRoot(stateDir, "ops");
    const homeRoot = accountStorageRoot(stateDir, "home", "fedcba9876543210");
    const roomId = "!room:example.org";
    const now = Date.now();
    const legacyKey = (eventId: string) =>
      `ops:${createHash("sha256").update(`ops\0${roomId}\0${eventId}`).digest("hex")}`;

    // July shape in a historical schema-v1 database. It intentionally has
    // none of the current schema's migration/audit tables.
    const legacyDatabasePath = path.join(sqliteRoot, "state", "openclaw.sqlite");
    const legacyDb = createLegacyDatabase(legacyDatabasePath);
    try {
      const statement = legacyDb.prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const marker = (eventId: string, ts: number) => JSON.stringify({ roomId, eventId, ts });
      const insert = (
        key: string,
        value: string,
        created: number,
        expires: number | null,
        namespace = "inbound-dedupe",
        plugin = "matrix",
      ) => statement.run(plugin, namespace, key, value, created, expires);
      insert(legacyKey("$committed"), marker("$committed", now - 60_000), 1, now + 60_000);
      insert(legacyKey("$stale"), marker("$stale", now - 31 * 86_400_000), 2, null);
      insert(legacyKey("$expired-corrupt"), "not-json", 3, now - 1);
      insert(
        "ops:legacy-json-marker",
        JSON.stringify({ importedAt: now }),
        4,
        now + 60_000,
        "inbound-dedupe-migrations",
      );
      insert("keep-matrix", '{"keep":true}', 5, null, "credentials");
      insert("keep-other", '{"keep":true}', 6, null, "inbound-dedupe", "other-plugin");
    } finally {
      legacyDb.close();
    }

    writeSqliteDedupeSource(homeRoot, "home", "$home-committed", now - 60_000);

    await expect(detect(DEDUPE)).resolves.toEqual(pendingDedupe);
    withDatabase(legacyDatabasePath, true, (detectedDb) => {
      expect(detectedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        detectedDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all(),
      ).toEqual([{ name: "plugin_state_entries" }]);
    });

    await expect(migrate(DEDUPE)).resolves.toEqual(
      dedupeMigrationResult([homeRoot, sqliteRoot], 2, 3),
    );

    await expect(enqueue("ops", "$committed")).resolves.toMatchObject({ kind: "completed" });
    await expect(enqueue("ops", "$stale")).resolves.toMatchObject({ kind: "accepted" });
    await expect(enqueue("home", "$home-committed")).resolves.toMatchObject({ kind: "completed" });

    // Only the two retired Matrix namespaces are deleted. The source remains
    // schema v1, with unrelated Matrix and other-plugin state untouched.
    withDatabase(legacyDatabasePath, true, (retiredDb) => {
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
    });
    await expect(detect(DEDUPE)).resolves.toBeNull();
  });

  it("does not require inbound dedupe migration for a fresh runtime account root", async () => {
    const storageRootDir = accountStorageRoot(stateDir);
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      snapshotJson: "[]",
      databaseCount: 0,
    });
    await closeOpenClawStateDatabaseAsync();

    params.config = { channels: { matrix: {} } };
    await expect(detect(DEDUPE)).resolves.toBeNull();

    writeSqliteDedupeSource(accountStorageRoot(stateDir, "legacy"), "legacy", "$old", Date.now());
    await expect(detect(DEDUPE)).resolves.toEqual(pendingDedupe);
  });

  it("allows an empty configured Matrix scan and then skips completed historical databases", async () => {
    params.config = { channels: { matrix: {} } };

    await expect(detect(DEDUPE)).resolves.toBeNull();
    await expect(migrate(DEDUPE)).resolves.toEqual(unchanged);
    const lateDatabasePath = path.join(
      accountStorageRoot(stateDir, "late"),
      "state",
      "openclaw.sqlite",
    );
    fs.mkdirSync(path.dirname(lateDatabasePath), { recursive: true });
    fs.writeFileSync(lateDatabasePath, "the completed migration must not open this database");
    await expect(detect(DEDUPE)).resolves.toBeNull();
    await expect(migrate(DEDUPE)).resolves.toEqual(unchanged);
  });

  it("withholds completion after a directory read failure and imports the source on retry", async () => {
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
    await expect(migrate(DEDUPE)).resolves.toEqual({
      changes: [],
      warnings: [
        `Failed scanning Matrix inbound dedupe sources under ${blockedDir}: Error: injected directory read failure`,
      ],
    });
    await expect(detect(DEDUPE)).resolves.toEqual(pendingDedupe);

    readdirSpy.mockRestore();
    await expect(migrate(DEDUPE)).resolves.toEqual(dedupeMigrationResult([storageRootDir], 1));
    await expect(enqueue("home", eventId)).resolves.toMatchObject({ kind: "completed" });
    await expect(detect(DEDUPE)).resolves.toBeNull();
  });

  it("refuses retired inbound dedupe JSON without changing bytes or recording completion", async () => {
    const source = "not-json";
    const storageRootDir = accountStorageRoot(stateDir, "home");
    fs.mkdirSync(storageRootDir, { recursive: true });
    const jsonPath = path.join(storageRootDir, "inbound-dedupe.json");
    fs.writeFileSync(jsonPath, source);
    const openStore = vi.spyOn(params.context, "openPluginStateKeyedStore");

    for (const run of [detect, migrate]) {
      await expect(run(DEDUPE)).rejects.toThrow("Install OpenClaw 2026.9.5");
    }
    expect(openStore).not.toHaveBeenCalled();
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(source);
    expect(fs.existsSync(`${jsonPath}.migrated`)).toBe(false);
  });

  it("keeps inbound dedupe sources when ingress import is unavailable", async () => {
    const storageRootDir = accountStorageRoot(stateDir, "home");
    const databasePath = writeSqliteDedupeSource(
      storageRootDir,
      "home",
      "$legacy",
      Date.now() - 60_000,
    );
    const sourceBytes = fs.readFileSync(databasePath);
    delete params.context.channelIngressQueues;

    await expect(migrate(DEDUPE)).resolves.toEqual({
      changes: [],
      warnings: [
        "Failed importing Matrix inbound dedupe markers: Error: Matrix ingress migration requires the host-owned ingress queue; left legacy sources in place",
      ],
    });
    expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
    await expect(detect(DEDUPE)).resolves.toEqual(pendingDedupe);
  });

  it("preserves a legacy marker's remaining ingress tombstone retention", async () => {
    const now = Date.now();
    const markerTs = now - MATRIX_INBOUND_DEDUPE_TTL_MS + 1_000;
    await expect(
      importInboundDedupeMarkersToIngress({
        context: params.context,
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

  it("moves current replay markers to account-scoped ingress after the historical migration completed", async () => {
    const store = openReplayMarkers();
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
    const migration = await migrationById("matrix-replay-guard-to-ingress");
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
    const store = openReplayMarkers();
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
    const migration = await migrationById("matrix-replay-guard-to-ingress");
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
      const credentials = legacyCredentials({
        accessToken: "secret-token",
        deviceId: "DEVICE123",
        lastUsedAt: "2026-07-02T12:00:00.000Z",
      });
      const filePath = writeCredentials(filename, credentials);
      if (accountIds.length > 0) {
        const accounts = Object.fromEntries(accountIds.map((id) => [id, {}]));
        params.config = { channels: { matrix: { accounts } } };
      }

      await expect(detect(CREDENTIALS)).resolves.toEqual({
        preview: ["Matrix credential JSON can migrate to SQLite (1 file)"],
      });
      const result = await migrate(CREDENTIALS);

      const store = openCredentials();
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
    const filePath = path.join(stateDir, "credentials", "matrix", "credentials-ops.json");
    const source = JSON.stringify(legacyCredentials({ accessToken: "synthetic-token" }));
    writeSource(filePath, source);
    const context = params.context;
    params.context = {
      ...context,
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        const store = context.openPluginStateKeyedStore<T>(options);
        return { ...store, registerIfAbsent: async () => false };
      },
    };

    const result = await migrate(CREDENTIALS);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Matrix credentials for account ops"),
    ]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
  });

  it.each(["revoked", "canonical"] as const)(
    "archives legacy credentials while preserving %s state",
    async (kind) => {
      const accountId = kind === "revoked" ? "ops" : "agent1";
      const legacy =
        kind === "revoked"
          ? legacyCredentials()
          : legacyCredentials({
              userId: "@agent1:example.org",
              deviceId: "LEGACYDEVICE",
              createdAt: "2026-07-02T12:00:00.000Z",
            });
      const filePath = writeCredentials(`credentials-${accountId}.json`, legacy);
      const credentialStore = openCredentials();
      const canonical: MatrixCredentialStateRecord =
        kind === "revoked"
          ? { accountId, kind: "revoked", revokedAt: "2026-07-02T12:00:00.000Z" }
          : {
              accountId,
              ...legacyCredentials({
                userId: "@agent1:example.org",
                accessToken: "canonical-token",
                deviceId: "CANONICALDEVICE",
              }),
            };
      await credentialStore.register(matrixCredentialsStoreKey(accountId), canonical);

      const result = await migrate(CREDENTIALS);

      expect(result).toMatchObject({
        warnings: [],
        changes: [
          kind === "revoked"
            ? "Archived revoked Matrix credential legacy source for account ops"
            : "Kept existing Matrix credentials for account agent1",
          expect.stringContaining("Archived Matrix credentials legacy source"),
        ],
      });
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
      if (kind === "canonical") {
        await expect(credentialStore.lookup(matrixCredentialsStoreKey(accountId))).resolves.toEqual(
          canonical,
        );
        expect(fs.existsSync(filePath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(`${filePath}.migrated`, "utf8"))).toMatchObject({
          accessToken: "legacy-token",
          deviceId: "LEGACYDEVICE",
        });
      }
    },
  );
});
