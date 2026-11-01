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

describe("matrix doctor contract state migrations", () => {
  let stateDir: string;
  let params: ReturnType<typeof createMigrationParams>;
  const detect = async (id: string) => (await migrationById(id)).detectLegacyState(params);
  const expectPendingDedupe = async () => expect(await detect(DEDUPE)).not.toBeNull();
  const migrate = async (id: string) => (await migrationById(id)).migrateLegacyState(params);
  const queueFor = (accountId: string) =>
    createChannelIngressQueueForTests({ channelId: "matrix", accountId, stateDir });
  const expectEnqueue = async (accountId: string, eventId: string, kind = "completed") =>
    expect(await queueFor(accountId).enqueue(eventId, {})).toMatchObject({ kind });
  const openCredentials = () =>
    params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
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
  const expectSource = (file: string, present: boolean, archived: boolean) => {
    expect(fs.existsSync(file)).toBe(present);
    expect(fs.existsSync(`${file}.migrated`)).toBe(archived);
  };
  const expectSyncToken = async (root: string, token: string | null) =>
    expect(await (await SqliteBackedMatrixSyncStore.create(root)).getSavedSyncToken()).toBe(token);
  const expectWarning = (result: Awaited<ReturnType<typeof migrate>>, warning: string) => {
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(warning)]);
  };
  const seedReplayMarkers = async (keys: string[], seenAt: number) => {
    const store = openReplayMarkers();
    for (const key of keys) {
      const entry = createPersistentDedupeImportEntry({ key, seenAt });
      await store.register(entry.key, entry.value);
    }
    return store;
  };
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

  it.each(["credentials", "sync-cache"] as const)(
    "retains malformed UTF-8 %s while importing a healthy account",
    async (kind) => {
      let filePath: string;
      let healthyPath: string;
      if (kind === "credentials") {
        filePath = writeCredentials(
          "credentials-broken.json",
          legacyCredentials({ accessToken: "utf8-marker" }),
        );
        healthyPath = writeCredentials("credentials-healthy.json", legacyCredentials());
      } else {
        const brokenRoot = accountStorageRoot(stateDir, "broken");
        const healthyRoot = accountStorageRoot(stateDir, "healthy");
        filePath = writeLegacySyncCache(brokenRoot, "utf8-marker");
        healthyPath = writeLegacySyncCache(healthyRoot, "healthy-token");
      }
      const bytes = fs.readFileSync(filePath);
      bytes[bytes.indexOf("utf8-marker")] = 0xff;
      fs.writeFileSync(filePath, bytes);
      const result = await migrate(kind === "credentials" ? CREDENTIALS : SYNC);
      expect(result.warningDisposition).toBe("recoverable");
      expect(result.warnings).toHaveLength(1);
      expect(fs.readFileSync(filePath)).toEqual(bytes);
      expect(fs.existsSync(healthyPath)).toBe(false);
      if (kind === "credentials") {
        expect(await openCredentials().lookup(matrixCredentialsStoreKey("broken"))).toBeUndefined();
        expect(await openCredentials().lookup(matrixCredentialsStoreKey("healthy"))).toMatchObject({
          accessToken: "legacy-token",
        });
      } else {
        await expectSyncToken(path.dirname(filePath), null);
        await expectSyncToken(path.dirname(healthyPath), "healthy-token");
      }
    },
  );

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
      expect(await detect(id)).not.toBeNull();
      const result = await migrate(id);
      expect(result.warnings).toEqual([]);
      if (sync) {
        for (const [i, root] of activeRoots.entries()) {
          await expectSyncToken(root, `legacy-token-${i}`);
          const store = await SqliteBackedMatrixSyncStore.create(root);
          expect(store.hasSavedSyncFromCleanShutdown()).toBe(true);
          expectSource(path.join(root, filename), false, true);
        }
      } else {
        for (const [i, accountId] of accounts.entries()) {
          await expectEnqueue(accountId, `$active-${i}`);
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

  it("archives sync sources without overwriting SQLite and reports archive failure", async () => {
    const storageRootDir = accountStorageRoot(stateDir);
    const sourcePath = path.join(storageRootDir, "bot-storage.json");
    const archivePath = `${sourcePath}.migrated`;
    writeLegacySyncCache(storageRootDir, "legacy-token");
    expect((await migrate(SYNC)).warnings).toEqual([]);
    expectSource(sourcePath, false, true);
    writeLegacySyncCache(storageRootDir, "newer-legacy-token");
    expect(await migrate(SYNC)).toMatchObject({ warnings: [], notices: [expect.any(String)] });
    expectSource(sourcePath, false, true);
    expect(fs.existsSync(`${archivePath}.2`)).toBe(true);
    await expectSyncToken(storageRootDir, "legacy-token");
    await expect(migrate(SYNC)).resolves.toEqual(unchanged);
    fs.writeFileSync(sourcePath, `${fs.readFileSync(`${sourcePath}.migrated.2`, "utf8")} `, "utf8");
    fs.mkdirSync(`${sourcePath}.migrated.3`);
    const failedArchive = await migrate(SYNC);
    expectWarning(failedArchive, "Failed archiving Matrix sync cache legacy source");
    expect(failedArchive.notices).toBeUndefined();
  });

  it("detects, imports, and retires schema-v1 inbound dedupe rows without upgrading the source", async () => {
    const sqliteRoot = accountStorageRoot(stateDir, "ops");
    const homeRoot = accountStorageRoot(stateDir, "home", "fedcba9876543210");
    const roomId = "!room:example.org";
    const now = Date.now();
    const legacyKey = (eventId: string) =>
      `ops:${createHash("sha256").update(`ops\0${roomId}\0${eventId}`).digest("hex")}`;
    const legacyDatabasePath = path.join(sqliteRoot, "state", "openclaw.sqlite");
    {
      using legacyDb = createLegacyDatabase(legacyDatabasePath);
      legacyDb.exec(`
        INSERT INTO plugin_state_entries VALUES
          ('matrix', 'inbound-dedupe', '${legacyKey("$committed")}',
           '{"roomId":"${roomId}","eventId":"$committed","ts":${now - 60_000}}', 1, ${now + 60_000}),
          ('matrix', 'inbound-dedupe', '${legacyKey("$stale")}',
           '{"roomId":"${roomId}","eventId":"$stale","ts":${now - 31 * 86_400_000}}', 2, NULL),
          ('matrix', 'inbound-dedupe', '${legacyKey("$expired-corrupt")}', 'not-json', 3, ${now - 1}),
          ('matrix', 'inbound-dedupe-migrations', 'ops:legacy-json-marker', '{"importedAt":${now}}', 4, ${now + 60_000}),
          ('matrix', 'credentials', 'keep-matrix', '{"keep":true}', 5, NULL),
          ('other-plugin', 'inbound-dedupe', 'keep-other', '{"keep":true}', 6, NULL);
      `);
    }
    writeSqliteDedupeSource(homeRoot, "home", "$home-committed", now - 60_000);
    await expectPendingDedupe();
    const expectLegacySchema = () =>
      withDatabase(legacyDatabasePath, true, (db) => {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
        ).toEqual([{ name: "plugin_state_entries" }]);
      });
    expectLegacySchema();
    expect((await migrate(DEDUPE)).warnings).toEqual([]);
    await expectEnqueue("ops", "$committed");
    await expectEnqueue("ops", "$stale", "accepted");
    await expectEnqueue("home", "$home-committed");
    expectLegacySchema();
    withDatabase(legacyDatabasePath, true, (retiredDb) => {
      expect(
        retiredDb
          .prepare(
            `SELECT plugin_id, namespace, entry_key, value_json
             FROM plugin_state_entries
             ORDER BY plugin_id ASC, namespace ASC, entry_key ASC`,
          )
          .all(),
      ).toEqual(
        [
          ["matrix", "credentials", "keep-matrix"],
          ["other-plugin", "inbound-dedupe", "keep-other"],
        ].map(([plugin_id, namespace, entry_key]) => ({
          plugin_id,
          namespace,
          entry_key,
          value_json: '{"keep":true}',
        })),
      );
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
    await expectPendingDedupe();
  });

  it("allows an empty configured Matrix scan and then skips completed historical databases", async () => {
    params.config = { channels: { matrix: {} } };
    await expect(detect(DEDUPE)).resolves.toBeNull();
    await expect(migrate(DEDUPE)).resolves.toEqual(unchanged);
    writeSource(
      path.join(accountStorageRoot(stateDir, "late"), "state", "openclaw.sqlite"),
      "the completed migration must not open this database",
    );
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
    expectWarning(await migrate(DEDUPE), "injected directory read failure");
    await expectPendingDedupe();
    readdirSpy.mockRestore();
    expect((await migrate(DEDUPE)).warnings).toEqual([]);
    await expectEnqueue("home", eventId);
    await expect(detect(DEDUPE)).resolves.toBeNull();
  });

  it("refuses retired inbound dedupe JSON without changing bytes or recording completion", async () => {
    const source = "not-json";
    const storageRootDir = accountStorageRoot(stateDir, "home");
    const jsonPath = writeSource(path.join(storageRootDir, "inbound-dedupe.json"), source);
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
    expectWarning(await migrate(DEDUPE), "requires the host-owned ingress queue");
    expect(fs.readFileSync(databasePath)).toEqual(sourceBytes);
    await expectPendingDedupe();
  });

  it("preserves a legacy marker's remaining ingress tombstone retention", async () => {
    const now = Date.now();
    const markerTs = now - MATRIX_INBOUND_DEDUPE_TTL_MS + 1_000;
    using _ = vi.spyOn(Date, "now").mockReturnValueOnce(now);
    await expect(
      importInboundDedupeMarkersToIngress({
        context: params.context,
        markers: [
          { accountId: "ops", roomId: "!room:example.org", eventId: "$near-expiry", ts: markerTs },
        ],
      }),
    ).resolves.toEqual({ imported: 1, total: 1 });
    const queue = queueFor("ops");
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

  it("retries account-scoped replay migration after partial commit, independently of historical completion", async () => {
    const seenAt = Date.now() - 60_000;
    const accounts = ["ops", "home"];
    const events = ["$first", "$second"];
    const store = await seedReplayMarkers(
      accounts.flatMap((account) =>
        events.map((event) => `${account}\0!room:example.org\0${event}`),
      ),
      seenAt,
    );
    await params.context
      .openPluginStateKeyedStore({
        namespace: "inbound-dedupe-migration-state",
        maxEntries: 4,
      })
      .register("sqlite-json-to-claimable-v1", { version: 1, completedAt: seenAt });
    const migration = await migrationById("matrix-replay-guard-to-ingress");
    expect(migration.doctorOnly).not.toBe(true);
    expect(await migration.detectLegacyState(params)).not.toBeNull();
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
    await expect(migration.migrateLegacyState(params)).rejects.toThrow(
      "injected ingress write failure",
    );
    await expect(store.entries()).resolves.toHaveLength(4);
    access.openChannelIngressQueue = openQueue;
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(store.entries()).resolves.toEqual([]);
    for (const account of accounts) {
      const queue = queueFor(account);
      await expect(queue.listPending()).resolves.toEqual([]);
      for (const event of events) {
        await expect(queue.enqueue(event, {})).resolves.toMatchObject({
          kind: "completed",
          record: { completedAt: seenAt },
        });
      }
    }
    expect(await migration.detectLegacyState(params)).toBeNull();
  });

  it.each([
    ["credentials-ops.json", [], "import", "ops"],
    ["credentials.json", ["ops"], "import", "ops"],
    ["credentials.json", ["ops", "alerts"], "ambiguous", null],
    ["credentials-ops.json", [], "revoked", "ops"],
    ["credentials-ops.json", [], "canonical", "ops"],
  ] as const)(
    "preserves credential migration for %s with accounts %j (%s)",
    async (filename, accountIds, kind, accountId) => {
      const credentials = legacyCredentials({
        deviceId: "LEGACYDEVICE",
        lastUsedAt: "2026-07-02T12:00:00.000Z",
      });
      const filePath = writeCredentials(filename, credentials);
      params.config.channels = {
        matrix: { accounts: Object.fromEntries(accountIds.map((id) => [id, {}])) },
      };
      const store = openCredentials();
      const canonical: MatrixCredentialStateRecord =
        kind === "revoked"
          ? { accountId: "ops", kind: "revoked", revokedAt: "2026-07-02T12:00:00.000Z" }
          : {
              accountId: "ops",
              ...legacyCredentials({ accessToken: "canonical-token", deviceId: "CANONICALDEVICE" }),
            };
      if (kind === "revoked" || kind === "canonical") {
        await store.register(matrixCredentialsStoreKey("ops"), canonical);
      }
      expect(await detect(CREDENTIALS)).not.toBeNull();
      const result = await migrate(CREDENTIALS);
      if (accountId === null) {
        expectWarning(result, "no default account is selected");
        await expect(store.entries()).resolves.toEqual([]);
        expectSource(filePath, true, false);
        return;
      }
      expect(result.warnings).toEqual([]);
      await expect(store.lookup(matrixCredentialsStoreKey(accountId))).resolves.toEqual(
        kind === "import" ? { accountId, ...credentials } : canonical,
      );
      expectSource(filePath, false, true);
      expect(JSON.parse(fs.readFileSync(`${filePath}.migrated`, "utf8"))).toEqual(credentials);
    },
  );

  it("retains credential sources when an absent-only import is refused", async () => {
    const source = JSON.stringify(legacyCredentials({ accessToken: "synthetic-token" }));
    const filePath = writeSource(
      path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
      source,
    );
    const context = params.context;
    params.context = {
      ...context,
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        const store = context.openPluginStateKeyedStore<T>(options);
        return { ...store, registerIfAbsent: async () => false };
      },
    };
    const result = await migrate(CREDENTIALS);
    expectWarning(result, "Failed importing Matrix credentials for account ops");
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
  });
});
