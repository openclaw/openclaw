// Matrix tests cover doctor contract state migrations.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { openMatrixStorageMetaStoreOptions } from "./src/matrix/client/storage.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  matrixCredentialsStoreKey,
  type MatrixCredentialStateRecord,
  type MatrixStoredCredentialRecord,
} from "./src/matrix/credentials-read.js";
import {
  MATRIX_RECOVERY_KEY_FILENAME,
  readMatrixIdbSnapshotJson,
  readMatrixRecoveryKeyStateForPath,
  scoreMatrixCryptoStateInStore,
} from "./src/matrix/crypto-state-store.js";
import { importNewestInboundDedupeMarkers } from "./src/matrix/monitor/inbound-dedupe-migration.js";
import {
  createMatrixInboundEventDeduper,
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  resolveMatrixInboundDedupeStateNamespace,
} from "./src/matrix/monitor/inbound-dedupe.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";

function createContext(): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
}

function createMigrationParams(stateDir: string) {
  return {
    config: {} as OpenClawConfig,
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(),
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

describe("matrix doctor contract state migrations", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports account credentials into SQLite before archiving the JSON", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const credentialsDir = path.join(stateDir, "credentials", "matrix");
    const filePath = path.join(credentialsDir, "credentials-ops.json");
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

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["Matrix credential JSON can migrate to SQLite (1 file)"],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Matrix credentials for account ops to SQLite",
      expect.stringContaining("Archived Matrix credentials legacy source"),
    ]);
    const store = params.context.openPluginStateKeyedStore<MatrixStoredCredentialRecord>({
      namespace: MATRIX_CREDENTIALS_NAMESPACE,
      maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(matrixCredentialsStoreKey("ops"))).resolves.toEqual({
      accountId: "ops",
      ...credentials,
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("archives legacy credentials without restoring an explicitly cleared account", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
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

  it("migrates legacy sync cache JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
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

    const store = new SqliteBackedMatrixSyncStore(storageRootDir);
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

  it("ignores archived Matrix trees while retaining active nested storage roots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const matrixRoot = path.join(stateDir, "matrix");
    const activeRoots = [
      path.join(matrixRoot, "accounts", "default", "matrix.example.org__bot", "095229939bddc71b"),
      path.join(
        matrixRoot,
        "accounts",
        "backup-operator",
        "current",
        "nested",
        "matrix.example.org__bot",
        "c1aa2a8a235f5f53",
      ),
    ];
    const archivedRoots = [
      path.join(
        matrixRoot,
        "accounts",
        "default",
        "matrix.example.org__bot",
        "095229939bddc71b.pre-stable-token-20260716",
      ),
      path.join(
        matrixRoot,
        "accounts",
        "default",
        "matrix.example.org__bot",
        "244f8f54ac105364.apr24-cutover-20260424",
      ),
      path.join(
        matrixRoot,
        "accounts",
        "default",
        "matrix.example.org__bot",
        "244f8f54ac105364.apr9-backup-20260409",
      ),
      path.join(
        matrixRoot,
        "accounts",
        "default",
        "matrix.example.org__bot",
        "c1aa2a8a235f5f53.reset-20260720",
      ),
      path.join(
        matrixRoot,
        "accounts",
        "default",
        "matrix.example.org__bot",
        "sync-cache-backup-after-limit1-20260720",
        "244f8f54ac105364",
      ),
    ];
    for (const [index, storageRootDir] of [...activeRoots, ...archivedRoots].entries()) {
      writeLegacySyncCache(storageRootDir, `legacy-token-${index}`);
    }

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: activeRoots
        .toSorted()
        .map((storageRootDir) => `Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`),
    });

    const result = await migration.migrateLegacyState(createMigrationParams(stateDir));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(activeRoots.length * 2);
    for (const storageRootDir of activeRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(false);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json.migrated"))).toBe(true);
    }
    for (const storageRootDir of archivedRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(true);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json.migrated"))).toBe(false);
    }
  });

  it("migrates Matrix storage metadata JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "storage-meta.json"),
      JSON.stringify({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accountId: "default",
        accessTokenHash: "0123456789abcdef",
        deviceId: "DEVICE",
        currentTokenStateClaimed: true,
      }),
    );

    const migration = migrationById("matrix-storage-meta-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix storage metadata JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix storage metadata JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix storage metadata legacy source -> ${path.join(storageRootDir, "storage-meta.json")}.migrated`,
      ],
      warnings: [],
    });

    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(storageRootDir),
    );
    await expect(store.lookup("current")).resolves.toMatchObject({
      deviceId: "DEVICE",
      currentTokenStateClaimed: true,
    });
    expect(fs.existsSync(path.join(storageRootDir, "storage-meta.json"))).toBe(false);
  });

  it("does not archive the legacy flat sync cache into an unread SQLite root", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
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

  it("migrates Matrix recovery-key JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "recovery-key.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "SSSS",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );

    const migration = migrationById("matrix-recovery-key-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix recovery-key JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix recovery-key JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix recovery key legacy source -> ${path.join(storageRootDir, "recovery-key.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(
      readMatrixRecoveryKeyStateForPath(path.join(storageRootDir, MATRIX_RECOVERY_KEY_FILENAME))
        ?.keyId,
    ).toBe("SSSS");
    expect(fs.existsSync(path.join(storageRootDir, "recovery-key.json"))).toBe(false);
  });

  it("migrates Matrix IndexedDB snapshot JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    const snapshot = [
      {
        name: "openclaw-matrix::matrix-sdk-crypto",
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
    fs.writeFileSync(
      path.join(storageRootDir, "crypto-idb-snapshot.json"),
      JSON.stringify(snapshot),
    );

    const migration = migrationById("matrix-idb-snapshot-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix IndexedDB snapshot JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix IndexedDB snapshot JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix IndexedDB snapshot legacy source -> ${path.join(storageRootDir, "crypto-idb-snapshot.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(JSON.parse(readMatrixIdbSnapshotJson(storageRootDir) ?? "null")).toEqual(snapshot);
    expect(fs.existsSync(path.join(storageRootDir, "crypto-idb-snapshot.json"))).toBe(false);
  });

  it("migrates Matrix legacy crypto migration JSON to SQLite plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageRootDir = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageRootDir, "legacy-crypto-migration.json"),
      JSON.stringify({
        version: 1,
        source: "matrix-bot-sdk-rust",
        accountId: "default",
        deviceId: "DEVICE",
        roomKeyCounts: { total: 2, backedUp: 2 },
        backupVersion: "1",
        decryptionKeyImported: true,
        restoreStatus: "pending",
        detectedAt: "2026-03-12T00:00:00.000Z",
        lastError: null,
      }),
    );

    const migration = migrationById("matrix-legacy-crypto-migration-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [`Matrix legacy crypto migration JSON can migrate to SQLite: ${storageRootDir}`],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        `Migrated Matrix legacy crypto migration JSON to SQLite for ${storageRootDir}`,
        `Archived Matrix legacy crypto migration legacy source -> ${path.join(storageRootDir, "legacy-crypto-migration.json")}.migrated`,
      ],
      warnings: [],
    });

    expect(scoreMatrixCryptoStateInStore(storageRootDir)).toBe(3);
    expect(fs.existsSync(path.join(storageRootDir, "legacy-crypto-migration.json"))).toBe(false);
  });

  it("migrates legacy inbound dedupe markers into the claimable dedupe store", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const sqliteRoot = path.join(
      stateDir,
      "matrix",
      "accounts",
      "ops",
      "matrix.example.org__bot",
      "095229939bddc71b",
    );
    const jsonRoot = path.join(
      stateDir,
      "matrix",
      "accounts",
      "home",
      "matrix.example.org__bot",
      "244f8f54ac105364",
    );
    fs.mkdirSync(sqliteRoot, { recursive: true });
    fs.mkdirSync(jsonRoot, { recursive: true });
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

    // >=2026.6 shape: per-storage-root SQLite rows plus JSON-import markers.
    const legacyStore = createPluginStateKeyedStoreForTests<{
      roomId: string;
      eventId: string;
      ts: number;
    }>("matrix", {
      namespace: "inbound-dedupe",
      maxEntries: 20_000,
      env: { OPENCLAW_STATE_DIR: sqliteRoot },
    });
    await legacyStore.register(legacyKey("ops", "$committed"), {
      roomId,
      eventId: "$committed",
      ts: now - 60_000,
    });
    await legacyStore.register(legacyKey("ops", "$expired"), {
      roomId,
      eventId: "$expired",
      ts: now - 31 * 24 * 60 * 60 * 1000,
    });
    const legacyMarkersStore = createPluginStateKeyedStoreForTests<{ importedAt: number }>(
      "matrix",
      {
        namespace: "inbound-dedupe-migrations",
        maxEntries: 1_000,
        env: { OPENCLAW_STATE_DIR: sqliteRoot },
      },
    );
    await legacyMarkersStore.register("ops:legacy-json-marker", { importedAt: now });

    // <=2026.5 shape: raw inbound-dedupe.json plus storage-meta.json identity.
    fs.writeFileSync(
      path.join(jsonRoot, "inbound-dedupe.json"),
      JSON.stringify({
        version: 1,
        entries: [{ key: `${roomId}|$json-committed`, ts: now - 60_000 }],
      }),
    );
    fs.writeFileSync(
      path.join(jsonRoot, "storage-meta.json"),
      JSON.stringify({ accountId: "home", userId: "@home:example.org" }),
    );

    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: [
        `Matrix inbound dedupe rows can migrate to the claimable dedupe store: ${sqliteRoot}`,
        `Matrix inbound dedupe JSON can migrate to the claimable dedupe store: ${path.join(jsonRoot, "inbound-dedupe.json")}`,
      ],
    });

    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the claimable dedupe store (2 of 3 entries)",
        `Retired Matrix inbound dedupe rows for ${sqliteRoot}`,
        `Archived Matrix inbound dedupe legacy source -> ${path.join(jsonRoot, "inbound-dedupe.json")}.migrated`,
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
    const expiredClaim = await opsDeduper.claim({ roomId, eventId: "$expired" });
    expect(expiredClaim.kind).toBe("claimed");
    if (expiredClaim.kind === "claimed") {
      expiredClaim.handle.release();
    }
    const homeDeduper = createMatrixInboundEventDeduper({
      auth: { accountId: "home" },
      env: dedupeEnv,
    });
    await expect(homeDeduper.claim({ roomId, eventId: "$json-committed" })).resolves.toEqual({
      kind: "duplicate",
    });

    // Legacy sources are retired and the migration is idempotent.
    await expect(legacyStore.entries()).resolves.toEqual([]);
    await expect(legacyMarkersStore.entries()).resolves.toEqual([]);
    expect(fs.existsSync(path.join(jsonRoot, "inbound-dedupe.json"))).toBe(false);
    expect(fs.existsSync(path.join(jsonRoot, "inbound-dedupe.json.migrated"))).toBe(true);
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toBeNull();
  });

  it("does not open or modify archived inbound dedupe SQLite roots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const storageParent = path.join(
      stateDir,
      "matrix",
      "accounts",
      "default",
      "matrix.example.org__bot",
    );
    const archivedRoots = [
      path.join(storageParent, "095229939bddc71b.pre-stable-token-20260716"),
      path.join(storageParent, "244f8f54ac105364.apr24-cutover-20260424"),
      path.join(storageParent, "244f8f54ac105364.apr9-backup-20260409"),
      path.join(storageParent, "c1aa2a8a235f5f53.reset-20260720"),
      path.join(storageParent, "sync-cache-backup-after-limit1-20260720", "244f8f54ac105364"),
    ];
    const archivedFiles: string[] = [];
    const archivedMtime = new Date("2026-07-16T12:00:00.000Z");
    for (const storageRootDir of archivedRoots) {
      const stateRoot = path.join(storageRootDir, "state");
      fs.mkdirSync(stateRoot, { recursive: true });
      for (const filename of ["openclaw.sqlite", "openclaw.sqlite-wal"]) {
        const filePath = path.join(stateRoot, filename);
        fs.writeFileSync(filePath, `preserved-${filename}`);
        fs.utimesSync(filePath, archivedMtime, archivedMtime);
        archivedFiles.push(filePath);
      }
    }
    const mtimesBefore = new Map(
      archivedFiles.map((filePath) => [filePath, fs.statSync(filePath).mtimeMs]),
    );
    const openedStateDirs: string[] = [];
    const params = createMigrationParams(stateDir);
    params.context = {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
        openedStateDirs.push(options.env?.OPENCLAW_STATE_DIR ?? "");
        throw new Error("archived Matrix state must not be opened");
      },
    };

    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(openedStateDirs).toEqual([]);
    for (const filePath of archivedFiles) {
      expect(fs.statSync(filePath).mtimeMs).toBe(mtimesBefore.get(filePath));
    }
  });

  it("archives malformed inbound dedupe JSON without importing it", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const jsonRoot = path.join(
      stateDir,
      "matrix",
      "accounts",
      "home",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    fs.mkdirSync(jsonRoot, { recursive: true });
    const jsonPath = path.join(jsonRoot, "inbound-dedupe.json");
    fs.writeFileSync(jsonPath, "not-json");

    const migration = migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
    await expect(migration.migrateLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      changes: [
        "Migrated Matrix inbound dedupe markers to the claimable dedupe store (0 of 0 entries)",
        `Archived Matrix inbound dedupe legacy source -> ${jsonPath}.migrated`,
      ],
      warnings: [
        `Matrix inbound dedupe JSON for ${jsonRoot} is malformed; archived without import`,
      ],
    });
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(`${jsonPath}.migrated`)).toBe(true);
  });

  it("keeps newer runtime dedupe rows when legacy imports hit capacity", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-doctor-"));
    tempDirs.push(stateDir);
    const io = { context: createContext(), env: { OPENCLAW_STATE_DIR: stateDir } };
    const roomId = "!room:example.org";
    const now = Date.now();
    // Simulate the row the upgraded runtime already committed post-upgrade.
    await expect(
      importNewestInboundDedupeMarkers({
        io,
        now,
        stateMaxEntries: 2,
        markers: [{ accountId: "ops", roomId, eventId: "$runtime", ts: now - 1_000 }],
      }),
    ).resolves.toEqual({ imported: 1, total: 1 });

    // Only one slot remains: the newest legacy marker wins, the runtime row survives.
    await expect(
      importNewestInboundDedupeMarkers({
        io,
        now,
        stateMaxEntries: 2,
        markers: [
          { accountId: "ops", roomId, eventId: "$old", ts: now - 60_000 },
          { accountId: "ops", roomId, eventId: "$newer", ts: now - 30_000 },
        ],
      }),
    ).resolves.toEqual({ imported: 1, total: 2 });

    const store = createPluginStateKeyedStoreForTests<{ key: string }>("matrix", {
      namespace: resolveMatrixInboundDedupeStateNamespace(),
      maxEntries: 2,
      defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
      env: io.env,
    });
    const keys = (await store.entries()).map((entry) => entry.value.key).toSorted();
    expect(keys).toEqual([`ops\0${roomId}\0$runtime`, `ops\0${roomId}\0$newer`].toSorted());
  });
});
