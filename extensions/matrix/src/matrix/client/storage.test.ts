// Matrix tests cover storage plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  openMatrixLegacyCryptoMigrationStoreOptions,
  openMatrixRecoveryKeyStoreOptions,
} from "../crypto-state-store.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";
import {
  claimCurrentTokenStorageState,
  maybeMigrateLegacyStorage,
  recordCurrentStorageMetaDeviceId,
  repairCurrentTokenStorageMetaDeviceId,
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";

describe("matrix client storage paths", () => {
  const tempDirs: string[] = [];
  const defaultStorageAuth = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "secret-token",
  };

  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTestLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
    logger = createTestLogger(),
  ): string {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    const stateDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(homeDir);
    installMatrixTestRuntime({
      cfg,
      logging: {
        getChildLogger: () => logger,
      },
      stateDir,
    });
    return stateDir;
  }

  function createMigrationEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      HOME: path.dirname(stateDir),
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
  }

  async function resolveDefaultStoragePaths(
    overrides: Partial<{
      homeserver: string;
      userId: string;
      accessToken: string;
      accountId: string;
      deviceId: string;
    }> = {},
  ) {
    return await resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      ...overrides,
      env: {},
    });
  }

  async function setupCurrentTokenBackfillScenario(params: {
    currentRootFiles: "thread-bindings" | "startup-verification";
    oldRootFiles: "crypto-only" | "thread-bindings";
  }) {
    const stateDir = setupStateDir();
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(canonicalPaths.rootDir, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: canonicalPaths.tokenHash,
      deviceId: null,
    });
    if (params.currentRootFiles === "thread-bindings") {
      writeJson(canonicalPaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-new",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:new",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
      expect(
        await claimCurrentTokenStorageState({
          rootDir: canonicalPaths.rootDir,
        }),
      ).toBe(true);
    } else {
      writeJson(canonicalPaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-old" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    if (params.oldRootFiles === "thread-bindings") {
      writeJson(oldStoragePaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-old",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:old",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
    } else {
      writeJson(oldStoragePaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    return { stateDir, canonicalPaths, oldStoragePaths };
  }

  it("resolves state file paths inside the selected storage root", async () => {
    setupStateDir();
    const filePath = await resolveMatrixStateFilePath({
      auth: {
        ...defaultStorageAuth,
        accountId: "ops",
        deviceId: "DEVICE1",
      },
      filename: "thread-bindings.json",
      env: {},
    });

    expect(filePath).toBe(
      path.join(
        (await resolveDefaultStoragePaths({ accountId: "ops", deviceId: "DEVICE1" })).rootDir,
        "thread-bindings.json",
      ),
    );
  });

  function legacySyncCacheBody(nextBatch = "legacy-token"): string {
    return JSON.stringify({
      version: 1,
      savedSync: {
        nextBatch,
        accountData: [],
        roomsData: {
          join: {},
          invite: {},
          leave: {},
          knock: {},
        },
      },
      cleanShutdown: true,
    });
  }

  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value, null, 2));
  }

  function readStorageMeta(rootDir: string): Record<string, unknown> | undefined {
    return createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    ).lookup("current");
  }

  function seedStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    ).register("current", value);
  }

  function seedLegacyStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    fs.mkdirSync(rootDir, { recursive: true });
    writeJson(rootDir, "storage-meta.json", value);
  }

  it("records a learned deviceId in SQLite storage metadata", async () => {
    const stateDir = setupStateDir();
    const storagePaths = await resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      await writeStorageMeta({
        storagePaths,
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        deviceId: null,
      }),
    ).toBe(true);

    expect(
      await recordCurrentStorageMetaDeviceId({
        rootDir: storagePaths.rootDir,
        deviceId: "DEVICE123",
      }),
    ).toBe(true);

    expect(readStorageMeta(storagePaths.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
    expect(fs.existsSync(path.join(storagePaths.rootDir, "startup-verification.json"))).toBe(false);
  });

  it.each(["claim", "initialize", "initialize-explicit"] as const)(
    "preserves a device learned while %s waits for persistence",
    async (operation) => {
      setupStateDir();
      const storagePaths = await resolveDefaultStoragePaths();
      seedStorageMeta(storagePaths.rootDir, {
        accessTokenHash: storagePaths.tokenHash,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      const runtime = getMatrixRuntime();
      const openStore = runtime.state.openKeyedStore.bind(runtime.state);
      const observed = createDeferred<void>();
      const resume = createDeferred<void>();
      let pause = true;
      vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
        const store = openStore(options);
        const observe = store.observe;
        if (options.namespace !== "storage-meta" || !observe) {
          return store;
        }
        return {
          ...store,
          observe: async (key) => {
            const result = await observe(key);
            if (pause) {
              pause = false;
              observed.resolve();
              await resume.promise;
            }
            return result;
          },
        };
      });
      const pending =
        operation === "claim"
          ? claimCurrentTokenStorageState({ rootDir: storagePaths.rootDir })
          : writeStorageMeta({
              storagePaths,
              homeserver: defaultStorageAuth.homeserver,
              userId: defaultStorageAuth.userId,
              deviceId: operation === "initialize-explicit" ? "EXPLICIT" : undefined,
            });
      try {
        await observed.promise;
        expect(
          await recordCurrentStorageMetaDeviceId({
            rootDir: storagePaths.rootDir,
            deviceId: "LEARNED",
          }),
        ).toBe(true);
        resume.resolve();
        expect(await pending).toBe(true);
        expect(readStorageMeta(storagePaths.rootDir)).toMatchObject({
          deviceId: operation === "initialize-explicit" ? "EXPLICIT" : "LEARNED",
          ...(operation === "claim" ? { currentTokenStateClaimed: true } : {}),
          createdAt: "2026-09-01T00:00:00.000Z",
        });
      } finally {
        resume.resolve();
        await pending;
      }
    },
  );

  it("does not create storage when device metadata has no current token to update", async () => {
    setupStateDir();
    const { rootDir } = await resolveDefaultStoragePaths();
    expect(await recordCurrentStorageMetaDeviceId({ rootDir, deviceId: "LEARNED" })).toBe(false);
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it.each(["older-host", "worker-failure"])(
    "selects the metadata compatibility path only for %s",
    async (mode) => {
      setupStateDir();
      const storagePaths = await resolveDefaultStoragePaths();
      seedStorageMeta(storagePaths.rootDir, {
        accessTokenHash: storagePaths.tokenHash,
        deviceId: "ORIGINAL",
      });
      const runtime = getMatrixRuntime();
      const openStore = runtime.state.openKeyedStore.bind(runtime.state);
      vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
        const store = openStore(options);
        return mode === "older-host"
          ? { ...store, observe: undefined, compareAndApply: undefined }
          : {
              ...store,
              compareAndApply: async () => {
                throw new Error("synthetic worker failure");
              },
            };
      });
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      expect(
        await recordCurrentStorageMetaDeviceId({ rootDir: storagePaths.rootDir, deviceId: "NEW" }),
      ).toBe(mode === "older-host");
      expect(native.mock.calls.length).toBe(mode === "older-host" ? 1 : 0);
      expect(readStorageMeta(storagePaths.rootDir)?.deviceId).toBe(
        mode === "older-host" ? "NEW" : "ORIGINAL",
      );
    },
  );

  async function seedExistingStorageRoot(params: {
    accessToken: string;
    deviceId?: string;
    storageBody?: string;
    storageMeta?: Record<string, unknown>;
    startupVerificationDeviceId?: string;
  }) {
    const storagePaths = await resolveDefaultStoragePaths({
      accessToken: params.accessToken,
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, params.storageBody ?? '{"legacy":true}');
    if (params.storageMeta) {
      seedStorageMeta(storagePaths.rootDir, params.storageMeta);
    }
    if (params.startupVerificationDeviceId) {
      writeJson(storagePaths.rootDir, "startup-verification.json", {
        deviceId: params.startupVerificationDeviceId,
      });
    }
    return storagePaths;
  }

  function seedCanonicalStorageRoot(params: {
    stateDir: string;
    accessToken: string;
    storageMeta: Record<string, unknown>;
  }) {
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir: params.stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: params.accessToken,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(canonicalPaths.rootDir, params.storageMeta);
    return canonicalPaths;
  }

  async function expectCanonicalRootForNewDevice(stateDir: string) {
    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
          .tokenHash,
        deviceId: "NEWDEVICE",
      },
    });

    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "NEWDEVICE",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
  }

  it("uses the simplified matrix runtime root for account-scoped storage", async () => {
    const stateDir = setupStateDir();

    const storagePaths = await resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@Bot:example.org",
      accessToken: "secret-token",
      accountId: "ops",
      env: {},
    });

    expect(storagePaths.rootDir).toBe(
      path.join(
        stateDir,
        "matrix",
        "accounts",
        "ops",
        "matrix.example.org__bot_example.org",
        storagePaths.tokenHash,
      ),
    );
    expect(storagePaths.storagePath).toBe(path.join(storagePaths.rootDir, "bot-storage.json"));
    expect(storagePaths.cryptoPath).toBe(path.join(storagePaths.rootDir, "crypto"));
    expect(storagePaths.recoveryKeyPath).toBe(path.join(storagePaths.rootDir, "recovery-key.json"));
    expect(storagePaths.idbSnapshotPath).toBe(
      path.join(storagePaths.rootDir, "crypto-idb-snapshot.json"),
    );
  });

  it("migrates the previous account-scoped sync cache into sqlite before startup", async () => {
    setupStateDir();
    const storagePaths = await resolveDefaultStoragePaths();
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, legacySyncCacheBody("account-token"));
    await maybeMigrateLegacyStorage({ storagePaths });

    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
    expect(fs.existsSync(`${storagePaths.storagePath}.migrated`)).toBe(true);
    const syncStore = await SqliteBackedMatrixSyncStore.create(storagePaths.rootDir);
    expect(syncStore.hasSavedSync()).toBe(true);
    await expect(syncStore.getSavedSyncToken()).resolves.toBe("account-token");
  });

  it("ignores unrecognized account-scoped sync cache files without a migration snapshot", async () => {
    setupStateDir();
    const storagePaths = await resolveDefaultStoragePaths();
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"new":true}');
    await maybeMigrateLegacyStorage({ storagePaths });

    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"new":true}');
  });

  it.each([
    { name: "without an unrelated sibling", withSentinel: false },
    { name: "with an unrelated sibling", withSentinel: true },
  ])(
    "preserves completed imports and retries a later archive failure $name",
    async ({ withSentinel }) => {
      setupStateDir();
      const storagePaths = await resolveDefaultStoragePaths();
      fs.mkdirSync(storagePaths.rootDir, { recursive: true });
      fs.writeFileSync(storagePaths.storagePath, legacySyncCacheBody("retry-token"));
      const recoveryKey = {
        version: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        keyId: "synthetic-key",
        privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      };
      const migrationState = {
        version: 1,
        accountId: "default",
        roomKeyCounts: null,
        restoreStatus: "pending",
      };
      writeJson(storagePaths.rootDir, "recovery-key.json", recoveryKey);
      writeJson(storagePaths.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME, migrationState);
      const migrationPath = path.join(
        storagePaths.rootDir,
        MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
      );
      const sentinelPath = `${storagePaths.rootDir} SQLite recovery key state`;
      const sentinel = "unrelated file must remain at its original path";
      if (withSentinel) {
        fs.writeFileSync(sentinelPath, sentinel);
      }
      const renameSync = fs.renameSync;
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (String(source) === migrationPath) {
          throw Object.assign(new Error("synthetic migration archive denied"), { code: "EACCES" });
        }
        renameSync(source, destination);
      });
      await expect(maybeMigrateLegacyStorage({ storagePaths })).rejects.toThrow(
        "synthetic migration archive denied",
      );
      rename.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();

      const expectPreservedState = () => {
        expect(
          createPluginStateSyncKeyedStoreForTests(
            "matrix",
            openMatrixRecoveryKeyStoreOptions(storagePaths.rootDir),
          ).lookup("current"),
        ).toEqual(recoveryKey);
        expect(
          JSON.parse(fs.readFileSync(`${storagePaths.recoveryKeyPath}.migrated`, "utf8")),
        ).toEqual(recoveryKey);
        expect(
          createPluginStateSyncKeyedStoreForTests(
            "matrix",
            openMatrixLegacyCryptoMigrationStoreOptions(storagePaths.rootDir),
          ).lookup("current"),
        ).toEqual(migrationState);
        expect
          .soft({
            recoverySource: fs.existsSync(storagePaths.recoveryKeyPath)
              ? fs.readFileSync(storagePaths.recoveryKeyPath, "utf8")
              : null,
            unrelatedFile: fs.existsSync(sentinelPath)
              ? fs.readFileSync(sentinelPath, "utf8")
              : null,
          })
          .toEqual({
            recoverySource: null,
            unrelatedFile: withSentinel ? sentinel : null,
          });
      };
      expectPreservedState();
      expect(fs.existsSync(storagePaths.storagePath)).toBe(true);
      expect(fs.existsSync(migrationPath)).toBe(true);
      expect(fs.existsSync(`${migrationPath}.migrated`)).toBe(false);
      await expect(
        (await SqliteBackedMatrixSyncStore.create(storagePaths.rootDir)).getSavedSyncToken(),
      ).resolves.toBe("retry-token");

      resetPluginStateStoreForTests();
      await maybeMigrateLegacyStorage({ storagePaths });
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();

      expectPreservedState();
      expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
      expect(fs.existsSync(`${storagePaths.storagePath}.migrated`)).toBe(true);
      expect(fs.existsSync(migrationPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(`${migrationPath}.migrated`, "utf8"))).toEqual(
        migrationState,
      );
      await expect(
        (await SqliteBackedMatrixSyncStore.create(storagePaths.rootDir)).getSavedSyncToken(),
      ).resolves.toBe("retry-token");
    },
  );

  it("keeps the canonical current-token storage root when deviceId is still unknown", async () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const rotatedStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });

    expect(rotatedStoragePaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(rotatedStoragePaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("reuses an existing token-hash storage root for the same device after the access token changes", async () => {
    const logger = createTestLogger();
    setupStateDir(undefined, logger);
    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-old" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });

    const rotatedStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns with structured metadata when populated token-hash storage roots accumulate", async () => {
    const logger = createTestLogger();
    const stateDir = setupStateDir(undefined, logger);
    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-old" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });
    const canonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(path.join(canonicalPaths.rootDir, "crypto"), { recursive: true });

    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: multiple populated token-hash storage roots detected",
      {
        parentDir: path.dirname(canonicalPaths.rootDir),
        canonicalTokenHash: canonicalPaths.tokenHash,
        selectedTokenHash: canonicalPaths.tokenHash,
        populatedTokenHashes: [canonicalPaths.tokenHash, oldStoragePaths.tokenHash],
        populatedSiblingTokenHashes: [oldStoragePaths.tokenHash],
        populatedRootCount: 2,
      },
    );
  });

  it("selects the canonical active root without inspecting archived siblings", async () => {
    const logger = createTestLogger();
    const stateDir = setupStateDir(undefined, logger);
    const canonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });
    const previousPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-old",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-old" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(path.join(previousPaths.rootDir, "crypto"), { recursive: true });
    const archivedTokenRoot = `${previousPaths.rootDir}.apr24-cutover-20260424`;
    fs.renameSync(previousPaths.rootDir, archivedTokenRoot);
    const archivedBackupRoot = path.join(
      path.dirname(canonicalPaths.rootDir),
      "sync-cache-backup-after-limit1-20260720",
    );
    fs.mkdirSync(archivedBackupRoot, { recursive: true });
    seedStorageMeta(archivedBackupRoot, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: "fedcba9876543210",
      deviceId: "DEVICE123",
    });
    fs.mkdirSync(path.join(archivedBackupRoot, "crypto"), { recursive: true });
    const archivedRoots = [archivedTokenRoot, archivedBackupRoot];
    resetPluginStateStoreForTests();

    const existsSync = vi.spyOn(fs, "existsSync");
    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(canonicalPaths.tokenHash);
    const inspectedPaths = existsSync.mock.calls.map(([filePath]) =>
      path.resolve(String(filePath)),
    );
    for (const storageRootDir of archivedRoots) {
      expect(
        inspectedPaths.some(
          (inspectedPath) =>
            inspectedPath === path.resolve(storageRootDir) ||
            inspectedPath.startsWith(`${path.resolve(storageRootDir)}${path.sep}`),
        ),
      ).toBe(false);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not scan token-history roots when the canonical current-token state is claimed", async () => {
    const logger = createTestLogger();
    const stateDir = setupStateDir(undefined, logger);
    const oldCanonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-old",
    });
    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: oldCanonicalPaths.tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });

    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });
    seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: canonicalPaths.tokenHash,
        deviceId: "DEVICE123",
        currentTokenStateClaimed: true,
      },
    });

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(readdirSync).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reads legacy storage metadata until doctor migrates it to SQLite", async () => {
    setupStateDir();
    const oldStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
    });
    seedLegacyStorageMeta(oldStoragePaths.rootDir, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: oldStoragePaths.tokenHash,
      deviceId: "DEVICE123",
      currentTokenStateClaimed: true,
    });

    const rotatedStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(fs.existsSync(path.join(oldStoragePaths.rootDir, "state", "openclaw.sqlite"))).toBe(
      false,
    );
  });

  it.each(["thread-bindings.json", "recovery-key.json", "crypto-idb-snapshot.json"])(
    "keeps a legacy %s root selectable until its state migrates",
    async (legacyFilename) => {
      const stateDir = setupStateDir();
      const oldStoragePaths = await resolveDefaultStoragePaths({
        accessToken: "secret-token-old",
        deviceId: "DEVICE123",
      });
      seedLegacyStorageMeta(oldStoragePaths.rootDir, {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: oldStoragePaths.tokenHash,
        deviceId: "DEVICE123",
      });
      writeJson(oldStoragePaths.rootDir, legacyFilename, { legacy: true });

      seedCanonicalStorageRoot({
        stateDir,
        accessToken: "secret-token-new",
        storageMeta: {
          homeserver: defaultStorageAuth.homeserver,
          userId: defaultStorageAuth.userId,
          accountId: "default",
          accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
            .tokenHash,
          deviceId: "DEVICE123",
        },
      });

      const rotatedStoragePaths = await resolveDefaultStoragePaths({
        accessToken: "secret-token-new",
        deviceId: "DEVICE123",
      });

      expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    },
  );

  it("scans for and prefers claimed current-token state over an unclaimed canonical root", async () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-old",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-old" }))
          .tokenHash,
        currentTokenStateClaimed: true,
        deviceId: "DEVICE123",
      },
    });
    seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
          .tokenHash,
        deviceId: "DEVICE123",
      },
    });

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const rotatedStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(readdirSync).toHaveBeenCalledOnce();
  });

  it("does not reuse a populated older token-hash root while deviceId is unknown", async () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = await seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        accessTokenHash: (await resolveDefaultStoragePaths({ accessToken: "secret-token-new" }))
          .tokenHash,
      },
    });

    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
    expect(resolvedPaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("does not reuse a populated sibling storage root from a different device", async () => {
    const stateDir = setupStateDir();
    await seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "OLDDEVICE",
      startupVerificationDeviceId: "OLDDEVICE",
    });
    await expectCanonicalRootForNewDevice(stateDir);
  });

  it("does not reuse a populated sibling storage root with ambiguous device metadata", async () => {
    const stateDir = setupStateDir();
    await seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });
    await expectCanonicalRootForNewDevice(stateDir);
  });

  it("keeps the current-token storage root stable after deviceId backfill when startup claimed state there", async () => {
    const { stateDir, canonicalPaths } = await setupCurrentTokenBackfillScenario({
      currentRootFiles: "thread-bindings",
      oldRootFiles: "crypto-only",
    });

    await repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    expect(readStorageMeta(canonicalPaths.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
    const startupPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    expect(startupPaths.rootDir).toBe(canonicalPaths.rootDir);
    const restartedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(canonicalPaths.rootDir);
  });

  it("does not keep the current-token storage root sticky when only marker files exist after backfill", async () => {
    const { stateDir, oldStoragePaths } = await setupCurrentTokenBackfillScenario({
      currentRootFiles: "startup-verification",
      oldRootFiles: "thread-bindings",
    });

    await repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    const restartedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(oldStoragePaths.rootDir);
  });
});
