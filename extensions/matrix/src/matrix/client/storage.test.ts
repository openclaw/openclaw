import { createHash } from "node:crypto";
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
  openMatrixRecoveryKeyStoreOptions,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { julyLegacyCryptoStoreOptions } from "./legacy-crypto-state.test-support.js";
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
  let homeDir: string;
  let stateDir: string;
  let logger: ReturnType<typeof createTestLogger>;
  const defaultStorageAuth = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "secret-token",
  };

  beforeEach(() => {
    resetPluginStateStoreForTests();
    logger = createTestLogger();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    stateDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    installMatrixTestRuntime({
      cfg: { channels: { matrix: {} } },
      logging: { getChildLogger: () => logger },
      stateDir,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function createTestLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  function createMigrationEnv(): NodeJS.ProcessEnv {
    return {
      HOME: path.dirname(stateDir),
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    };
  }

  async function resolveDefaultStoragePaths(
    overrides: Partial<typeof defaultStorageAuth> & { accountId?: string; deviceId?: string } = {},
  ) {
    return await resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      ...overrides,
      env: {},
    });
  }

  function storageMeta(accessTokenHash: string, extra: Record<string, unknown> = {}) {
    return {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash,
      deviceId: "DEVICE123",
      ...extra,
    };
  }

  function canonicalRoot(accessToken: string) {
    return resolveMatrixAccountStorageRoot({ ...defaultStorageAuth, stateDir, accessToken });
  }

  function resolveRotatedDevice(deviceId = "DEVICE123") {
    return resolveDefaultStoragePaths({ accessToken: "secret-token-new", deviceId });
  }

  it("resolves state file paths inside the selected storage root", async () => {
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

  function metadataStore(rootDir: string) {
    return createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    );
  }

  function stateStore(options: Parameters<typeof createPluginStateSyncKeyedStoreForTests>[1]) {
    return createPluginStateSyncKeyedStoreForTests("matrix", options);
  }

  function readStorageMeta(rootDir: string) {
    return metadataStore(rootDir).lookup("current");
  }

  function seedStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    metadataStore(rootDir).register("current", value);
  }

  function seedThreadBinding(rootDir: string, suffix: "new" | "old"): void {
    const conversationId = `$thread-${suffix}`;
    const digest = createHash("sha256").update(`default\0\0${conversationId}`).digest("hex");
    createPluginStateSyncKeyedStoreForTests("matrix", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
      env: { OPENCLAW_STATE_DIR: rootDir },
    }).register(`default:${digest}`, {
      accountId: "default",
      conversationId,
      targetKind: "subagent",
      targetSessionKey: `agent:ops:subagent:${suffix}`,
      boundAt: 1,
      lastActivityAt: 1,
    });
  }

  function seedStartupVerification(rootDir: string, deviceId: string): void {
    createPluginStateSyncKeyedStoreForTests("matrix", {
      namespace: "startup-verification",
      maxEntries: 1_000,
      env: { OPENCLAW_STATE_DIR: rootDir },
    }).register("default", {
      userId: defaultStorageAuth.userId,
      deviceId,
      attemptedAt: "2026-07-13T12:00:00.000Z",
      outcome: "requested",
      requestId: "verification-1",
      transactionId: "txn-1",
    });
  }

  function seedLegacyStorageMeta(rootDir: string, value: Record<string, unknown>): void {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "storage-meta.json"), JSON.stringify(value, null, 2));
  }

  it.each(["claim", "initialize", "initialize-explicit"] as const)(
    "preserves a device learned while %s waits for persistence",
    async (operation) => {
      const storagePaths = await resolveDefaultStoragePaths();
      seedStorageMeta(storagePaths.rootDir, {
        accessTokenHash: storagePaths.tokenHash,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      const runtime = getMatrixRuntime();
      const openStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
      const observed = createDeferred<void>();
      const resume = createDeferred<void>();
      let pause = true;
      vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation((options) => {
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
    const { rootDir } = await resolveDefaultStoragePaths();
    expect(await recordCurrentStorageMetaDeviceId({ rootDir, deviceId: "LEARNED" })).toBe(false);
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it("preserves metadata when its worker write fails", async () => {
    const storagePaths = await resolveDefaultStoragePaths();
    seedStorageMeta(storagePaths.rootDir, {
      accessTokenHash: storagePaths.tokenHash,
      deviceId: "ORIGINAL",
    });
    const runtime = getMatrixRuntime();
    const openStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
    vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation((options) => {
      const store = openStore(options);
      return {
        ...store,
        compareAndApply: async () => {
          throw new Error("synthetic worker failure");
        },
      };
    });
    const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
    expect(
      await recordCurrentStorageMetaDeviceId({ rootDir: storagePaths.rootDir, deviceId: "NEW" }),
    ).toBe(false);
    expect(native).not.toHaveBeenCalled();
    expect(readStorageMeta(storagePaths.rootDir)?.deviceId).toBe("ORIGINAL");
  });

  async function seedOldStorageRoot(
    params: {
      deviceId?: string;
      metadata?: false;
      startupVerificationDeviceId?: string;
    } = {},
  ) {
    const storagePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-old",
      deviceId: params.deviceId ?? "DEVICE123",
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"legacy":true}');
    if (params.metadata !== false) {
      seedStorageMeta(storagePaths.rootDir, storageMeta(storagePaths.tokenHash));
    }
    if (params.startupVerificationDeviceId) {
      seedStartupVerification(storagePaths.rootDir, params.startupVerificationDeviceId);
    }
    return storagePaths;
  }

  function seedCanonicalStorageRoot(
    accessToken = "secret-token-new",
    extra: Record<string, unknown> = {},
  ) {
    const canonicalPaths = canonicalRoot(accessToken);
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(canonicalPaths.rootDir, storageMeta(canonicalPaths.tokenHash, extra));
    return canonicalPaths;
  }

  it("migrates the previous account-scoped sync cache into sqlite before startup", async () => {
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
    const storagePaths = await resolveDefaultStoragePaths();
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"new":true}');
    await maybeMigrateLegacyStorage({ storagePaths });

    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"new":true}');
  });

  it("preserves completed imports and retries a later archive failure with an unrelated sibling", async () => {
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
    const recoveryStore = () => stateStore(openMatrixRecoveryKeyStoreOptions(storagePaths.rootDir));
    const migrationStore = () => stateStore(julyLegacyCryptoStoreOptions(storagePaths.rootDir));
    recoveryStore().register("current", recoveryKey);
    migrationStore().register("current", migrationState);
    const migrationPath = storagePaths.storagePath;
    const sentinelPath = `${storagePaths.rootDir} SQLite sync cache`;
    const sentinel = "unrelated file must remain at its original path";
    fs.writeFileSync(sentinelPath, sentinel);
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
      expect(recoveryStore().lookup("current")).toEqual(recoveryKey);
      expect(migrationStore().lookup("current")).toEqual(migrationState);
      expect
        .soft({
          recoverySource: fs.existsSync(storagePaths.recoveryKeyPath)
            ? fs.readFileSync(storagePaths.recoveryKeyPath, "utf8")
            : null,
          unrelatedFile: fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, "utf8") : null,
        })
        .toEqual({
          recoverySource: null,
          unrelatedFile: sentinel,
        });
    };
    expectPreservedState();
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
    expect(fs.existsSync(migrationPath)).toBe(false);
    expect(fs.readFileSync(`${migrationPath}.migrated`, "utf8")).toBe(
      legacySyncCacheBody("retry-token"),
    );
    await expect(
      (await SqliteBackedMatrixSyncStore.create(storagePaths.rootDir)).getSavedSyncToken(),
    ).resolves.toBe("retry-token");
  });

  it("warns with structured metadata when populated token-hash storage roots accumulate", async () => {
    const oldStoragePaths = await seedOldStorageRoot();
    const canonicalPaths = seedCanonicalStorageRoot();
    fs.mkdirSync(path.join(canonicalPaths.rootDir, "crypto"), { recursive: true });

    const resolvedPaths = await resolveRotatedDevice();

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
    const canonicalPaths = seedCanonicalStorageRoot();
    const previousPaths = seedCanonicalStorageRoot("secret-token-old");
    fs.mkdirSync(path.join(previousPaths.rootDir, "crypto"), { recursive: true });
    const archivedTokenRoot = `${previousPaths.rootDir}.apr24-cutover-20260424`;
    fs.renameSync(previousPaths.rootDir, archivedTokenRoot);
    const archivedBackupRoot = path.join(
      path.dirname(canonicalPaths.rootDir),
      "sync-cache-backup-after-limit1-20260720",
    );
    fs.mkdirSync(archivedBackupRoot, { recursive: true });
    seedStorageMeta(archivedBackupRoot, storageMeta("fedcba9876543210"));
    fs.mkdirSync(path.join(archivedBackupRoot, "crypto"), { recursive: true });
    const archivedRoots = [archivedTokenRoot, archivedBackupRoot];
    resetPluginStateStoreForTests();

    const existsSync = vi.spyOn(fs, "existsSync");
    const resolvedPaths = await resolveRotatedDevice();

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
    const oldStoragePaths = await seedOldStorageRoot();
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });

    const canonicalPaths = seedCanonicalStorageRoot("secret-token-new", {
      currentTokenStateClaimed: true,
    });

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const resolvedPaths = await resolveRotatedDevice();

    expect(resolvedPaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(readdirSync).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refuses retired storage metadata without selecting or rewriting its root", async () => {
    const oldStoragePaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
    });
    seedLegacyStorageMeta(
      oldStoragePaths.rootDir,
      storageMeta(oldStoragePaths.tokenHash, { currentTokenStateClaimed: true }),
    );

    const sourcePath = path.join(oldStoragePaths.rootDir, "storage-meta.json");
    const source = fs.readFileSync(sourcePath, "utf8");
    await expect(
      resolveDefaultStoragePaths({ accessToken: "secret-token-new", deviceId: "DEVICE123" }),
    ).rejects.toThrow("Install OpenClaw 2026.9.5");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
    expect(fs.existsSync(path.join(oldStoragePaths.rootDir, "state", "openclaw.sqlite"))).toBe(
      false,
    );
  });

  it.each(["recovery-key", "idb-snapshot"])(
    "keeps a July SQLite %s root selectable across token rotation",
    async (namespace) => {
      const oldStoragePaths = await resolveDefaultStoragePaths({
        accessToken: "secret-token-old",
        deviceId: "DEVICE123",
      });
      seedStorageMeta(oldStoragePaths.rootDir, storageMeta(oldStoragePaths.tokenHash));
      if (namespace === "recovery-key") {
        stateStore(openMatrixRecoveryKeyStoreOptions(oldStoragePaths.rootDir)).register("current", {
          version: 1,
          createdAt: "2026-07-01T00:00:00.000Z",
          keyId: "fixture-key",
          privateKeyBase64: "AQIDBA==",
        });
      } else {
        await writeMatrixIdbSnapshotJson({
          storageRootDir: oldStoragePaths.rootDir,
          snapshotJson: JSON.stringify([{ name: "fixture-crypto", version: 1, stores: [] }]),
          databaseCount: 1,
        });
      }

      seedCanonicalStorageRoot();

      const rotatedStoragePaths = await resolveRotatedDevice();

      expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    },
  );

  it("scans for and prefers claimed current-token state over an unclaimed canonical root", async () => {
    const oldStoragePaths = seedCanonicalStorageRoot("secret-token-old", {
      currentTokenStateClaimed: true,
    });
    seedCanonicalStorageRoot();

    const readdirSync = vi.spyOn(fs, "readdirSync");
    const rotatedStoragePaths = await resolveRotatedDevice();

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(readdirSync).toHaveBeenCalledOnce();
  });

  it("does not reuse a populated older token-hash root while deviceId is unknown", async () => {
    const oldStoragePaths = await seedOldStorageRoot({ metadata: false });

    const newerCanonicalPaths = canonicalRoot("secret-token-new");
    fs.mkdirSync(newerCanonicalPaths.rootDir, { recursive: true });
    seedStorageMeta(newerCanonicalPaths.rootDir, {
      accessTokenHash: newerCanonicalPaths.tokenHash,
    });

    const resolvedPaths = await resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
    expect(resolvedPaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("does not reuse a populated sibling storage root from a different device", async () => {
    await seedOldStorageRoot({
      deviceId: "OLDDEVICE",
      metadata: false,
      startupVerificationDeviceId: "OLDDEVICE",
    });
    const newerCanonicalPaths = seedCanonicalStorageRoot("secret-token-new", {
      deviceId: "NEWDEVICE",
    });

    const resolvedPaths = await resolveRotatedDevice("NEWDEVICE");

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
  });

  it("does not reuse a populated sibling storage root with ambiguous device metadata", async () => {
    const storagePaths = await resolveDefaultStoragePaths({ accessToken: "secret-token-old" });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"legacy":true}');
    const canonicalPaths = seedCanonicalStorageRoot("secret-token-new", {
      deviceId: "NEWDEVICE",
    });
    const resolved = await resolveRotatedDevice("NEWDEVICE");
    expect(resolved.rootDir).toBe(canonicalPaths.rootDir);
    expect(resolved.tokenHash).toBe(canonicalPaths.tokenHash);
  });

  it.each([true, false])("keeps backfilled roots sticky only when claimed: %s", async (claimed) => {
    const canonicalPaths = seedCanonicalStorageRoot("secret-token-new", {
      deviceId: null,
    });
    if (claimed) {
      seedThreadBinding(canonicalPaths.rootDir, "new");
      expect(await claimCurrentTokenStorageState(canonicalPaths)).toBe(true);
    } else {
      seedStartupVerification(canonicalPaths.rootDir, "DEVICE123");
    }

    const oldStoragePaths = await seedOldStorageRoot();
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    if (!claimed) {
      seedThreadBinding(oldStoragePaths.rootDir, "old");
    } else {
      seedStartupVerification(oldStoragePaths.rootDir, "DEVICE123");
    }

    await repairCurrentTokenStorageMetaDeviceId({
      ...defaultStorageAuth,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(),
    });
    if (claimed) {
      expect(readStorageMeta(canonicalPaths.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
      const startupPaths = await resolveDefaultStoragePaths({ accessToken: "secret-token-new" });
      expect(startupPaths.rootDir).toBe(canonicalPaths.rootDir);
    }
    const restartedPaths = await resolveRotatedDevice();
    expect(restartedPaths.rootDir).toBe((claimed ? canonicalPaths : oldStoragePaths).rootDir);
  });
});
