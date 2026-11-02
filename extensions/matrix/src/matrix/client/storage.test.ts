import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { withResolvedRuntimeMatrixClient } from "../client-bootstrap.js";
import {
  openMatrixRecoveryKeyStoreOptions,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import { createMatrixClient } from "./create-client.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { julyLegacyCryptoStoreOptions } from "./legacy-crypto-state.test-support.js";
import { acquireSharedMatrixClient, type SharedMatrixClientLease } from "./shared.js";
import { authFor } from "./shared.test-support.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";
import {
  claimCurrentTokenStorageState,
  maybeMigrateLegacyStorage,
  recordCurrentStorageMetaDeviceId,
  repairCurrentTokenStorageMetaDeviceId,
  resolveMatrixStoragePaths,
  writeStorageMeta,
} from "./storage.js";
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  resolveValidatedMatrixHomeserverUrl: async (url: string) => url,
}));
let homeDir: string;
let stateDir: string;
let logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const defaultAuth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "secret-token",
};
const recoveryKey = {
  version: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  keyId: "synthetic-key",
  privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
};
const migration = {
  version: 1,
  accountId: "default",
  roomKeyCounts: null,
  restoreStatus: "pending",
};
const clientAuth = { ...defaultAuth, deviceId: "DEVICE123" };
const leases: SharedMatrixClientLease[] = [];
beforeEach(() => {
  resetPluginStateStoreForTests();
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
  await Promise.allSettled(leases.splice(0).map((lease) => lease.release({ mode: "discard" })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  fs.rmSync(homeDir, { recursive: true, force: true });
});
async function resolvePaths(
  overrides: Partial<typeof defaultAuth> & { accountId?: string; deviceId?: string } = {},
) {
  return await resolveMatrixStoragePaths({ ...defaultAuth, ...overrides, env: {} });
}
function storageMeta(accessTokenHash: string, extra: Record<string, unknown> = {}) {
  return {
    homeserver: defaultAuth.homeserver,
    userId: defaultAuth.userId,
    accountId: "default",
    accessTokenHash,
    deviceId: "DEVICE123",
    ...extra,
  };
}
function canonicalRoot(accessToken: string) {
  return resolveMatrixAccountStorageRoot({ ...defaultAuth, stateDir, accessToken });
}
function resolveRotatedDevice(deviceId = "DEVICE123") {
  return resolvePaths({ accessToken: "secret-token-new", deviceId });
}
function legacySyncCacheBody(nextBatch = "legacy-token"): string {
  return JSON.stringify({
    version: 1,
    savedSync: {
      nextBatch,
      accountData: [],
      roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
    },
    cleanShutdown: true,
  });
}
async function seedSyncFile(body: string | Buffer) {
  const paths = await resolvePaths();
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.writeFileSync(paths.storagePath, body);
  return paths;
}
function expectSelected(
  actual: { rootDir: string; tokenHash: string },
  expected: { rootDir: string; tokenHash: string },
) {
  expect(actual).toMatchObject({ rootDir: expected.rootDir, tokenHash: expected.tokenHash });
}
it("retains malformed UTF-8 legacy sync cache without aborting client initialization", async () => {
  const bytes = Buffer.from(legacySyncCacheBody("utf8-marker"));
  bytes[bytes.indexOf("utf8-marker")] = 0xff;
  const paths = await seedSyncFile(bytes);
  await expect(maybeMigrateLegacyStorage({ storagePaths: paths })).resolves.toBeUndefined();
  expect(fs.readFileSync(paths.storagePath)).toEqual(bytes);
  expect(fs.existsSync(`${paths.storagePath}.migrated`)).toBe(false);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("must be valid UTF-8"));
  const store = await SqliteBackedMatrixSyncStore.create(paths.rootDir);
  expect(await store.getSavedSyncToken()).toBeNull();
});
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
it.each(["claim", "initialize", "initialize-explicit"] as const)(
  "keeps a learned device during %s",
  async (operation) => {
    const paths = await resolvePaths();
    seedStorageMeta(paths.rootDir, {
      accessTokenHash: paths.tokenHash,
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
        ? claimCurrentTokenStorageState({ rootDir: paths.rootDir })
        : writeStorageMeta({
            storagePaths: paths,
            homeserver: defaultAuth.homeserver,
            userId: defaultAuth.userId,
            deviceId: operation === "initialize-explicit" ? "EXPLICIT" : undefined,
          });
    try {
      await observed.promise;
      expect(
        await recordCurrentStorageMetaDeviceId({
          rootDir: paths.rootDir,
          deviceId: "LEARNED",
        }),
      ).toBe(true);
      resume.resolve();
      expect(await pending).toBe(true);
      expect(readStorageMeta(paths.rootDir)).toMatchObject({
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
  const { rootDir } = await resolvePaths();
  expect(await recordCurrentStorageMetaDeviceId({ rootDir, deviceId: "LEARNED" })).toBe(false);
  expect(fs.existsSync(rootDir)).toBe(false);
});
it("preserves metadata when its worker write fails", async () => {
  const paths = await resolvePaths();
  seedStorageMeta(paths.rootDir, {
    accessTokenHash: paths.tokenHash,
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
  expect(await recordCurrentStorageMetaDeviceId({ rootDir: paths.rootDir, deviceId: "NEW" })).toBe(
    false,
  );
  expect(native).not.toHaveBeenCalled();
  expect(readStorageMeta(paths.rootDir)?.deviceId).toBe("ORIGINAL");
});
function seedCanonicalStorageRoot(
  accessToken = "secret-token-new",
  extra: Record<string, unknown> = {},
) {
  const canonical = canonicalRoot(accessToken);
  seedStorageMeta(canonical.rootDir, storageMeta(canonical.tokenHash, extra));
  return canonical;
}
it("migrates the previous account-scoped sync cache into sqlite before startup", async () => {
  const paths = await seedSyncFile(legacySyncCacheBody("account-token"));
  await maybeMigrateLegacyStorage({ storagePaths: paths });
  expect(fs.existsSync(paths.storagePath)).toBe(false);
  expect(fs.existsSync(`${paths.storagePath}.migrated`)).toBe(true);
  const store = await SqliteBackedMatrixSyncStore.create(paths.rootDir);
  expect(store.hasSavedSync()).toBe(true);
  await expect(store.getSavedSyncToken()).resolves.toBe("account-token");
});
it("ignores unrecognized account-scoped sync cache files without a migration snapshot", async () => {
  const paths = await seedSyncFile('{"new":true}');
  await maybeMigrateLegacyStorage({ storagePaths: paths });
  expect(fs.readFileSync(paths.storagePath, "utf8")).toBe('{"new":true}');
});
it("preserves completed imports and retries a later archive failure with an unrelated sibling", async () => {
  const paths = await seedSyncFile(legacySyncCacheBody("retry-token"));
  const recoveryStore = () => stateStore(openMatrixRecoveryKeyStoreOptions(paths.rootDir));
  const migrationStore = () => stateStore(julyLegacyCryptoStoreOptions(paths.rootDir));
  recoveryStore().register("current", recoveryKey);
  migrationStore().register("current", migration);
  const migrationPath = paths.storagePath;
  const sentinelPath = `${paths.rootDir} SQLite sync cache`;
  const sentinel = "unrelated file must remain at its original path";
  fs.writeFileSync(sentinelPath, sentinel);
  const renameSync = fs.renameSync;
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (String(source) === migrationPath) {
      throw Object.assign(new Error("synthetic migration archive denied"), { code: "EACCES" });
    }
    renameSync(source, destination);
  });
  await expect(maybeMigrateLegacyStorage({ storagePaths: paths })).rejects.toThrow(
    "synthetic migration archive denied",
  );
  rename.mockRestore();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const expectPreservedState = () => {
    expect(recoveryStore().lookup("current")).toEqual(recoveryKey);
    expect(migrationStore().lookup("current")).toEqual(migration);
    expect.soft(fs.existsSync(paths.recoveryKeyPath)).toBe(false);
    expect.soft(fs.readFileSync(sentinelPath, "utf8")).toBe(sentinel);
  };
  expectPreservedState();
  expect(fs.existsSync(migrationPath)).toBe(true);
  expect(fs.existsSync(`${migrationPath}.migrated`)).toBe(false);
  await expect(
    (await SqliteBackedMatrixSyncStore.create(paths.rootDir)).getSavedSyncToken(),
  ).resolves.toBe("retry-token");
  resetPluginStateStoreForTests();
  await maybeMigrateLegacyStorage({ storagePaths: paths });
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  expectPreservedState();
  expect(fs.existsSync(migrationPath)).toBe(false);
  expect(fs.readFileSync(`${migrationPath}.migrated`, "utf8")).toBe(
    legacySyncCacheBody("retry-token"),
  );
  await expect(
    (await SqliteBackedMatrixSyncStore.create(paths.rootDir)).getSavedSyncToken(),
  ).resolves.toBe("retry-token");
});
it.each(["canonical crypto", "claimed canonical", "claimed sibling"])(
  "prefers the %s root",
  async (owner) => {
    const old = seedCanonicalStorageRoot("secret-token-old", {
      currentTokenStateClaimed: owner === "claimed sibling",
    });
    const canonical = seedCanonicalStorageRoot("secret-token-new", {
      currentTokenStateClaimed: owner === "claimed canonical",
    });
    if (owner !== "claimed sibling") {
      fs.mkdirSync(path.join((owner === "canonical crypto" ? canonical : old).rootDir, "crypto"));
    }
    const scan = vi.spyOn(fs, "readdirSync");
    expectSelected(await resolveRotatedDevice(), owner === "claimed sibling" ? old : canonical);
    if (owner === "claimed canonical") {
      expect(scan).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    } else {
      expect(scan).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("multiple populated token-hash storage roots"),
        expect.objectContaining({ populatedRootCount: 2 }),
      );
    }
  },
);
it("ignores archived token and backup roots even when they contain retired state", async () => {
  const canonical = seedCanonicalStorageRoot();
  const archivedNames = [
    canonicalRoot("secret-token-old").tokenHash + ".apr24-cutover-20260424",
    "sync-cache-backup-after-limit1-20260720",
  ];
  for (const name of archivedNames) {
    const archive = path.join(path.dirname(canonical.rootDir), name);
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, "storage-meta.json"), "{}");
  }
  expectSelected(await resolveRotatedDevice(), canonical);
  expect(logger.warn).not.toHaveBeenCalled();
});
it("refuses retired storage metadata without selecting or rewriting its root", async () => {
  const old = await resolvePaths({
    accessToken: "secret-token-old",
    deviceId: "DEVICE123",
  });
  fs.mkdirSync(old.rootDir, { recursive: true });
  const sourcePath = path.join(old.rootDir, "storage-meta.json");
  fs.writeFileSync(
    sourcePath,
    JSON.stringify(storageMeta(old.tokenHash, { currentTokenStateClaimed: true })),
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  await expect(resolveRotatedDevice()).rejects.toThrow("Install OpenClaw 2026.9.5");
  expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
  expect(fs.existsSync(path.join(old.rootDir, "state", "openclaw.sqlite"))).toBe(false);
});
it.each(["recovery-key", "idb-snapshot"])(
  "reuses July SQLite %s on rotation",
  async (namespace) => {
    const old = await resolvePaths({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
    });
    seedStorageMeta(old.rootDir, storageMeta(old.tokenHash));
    if (namespace === "recovery-key") {
      stateStore(openMatrixRecoveryKeyStoreOptions(old.rootDir)).register("current", {
        version: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        keyId: "fixture-key",
        privateKeyBase64: "AQIDBA==",
      });
    } else {
      await writeMatrixIdbSnapshotJson({
        storageRootDir: old.rootDir,
        snapshotJson: JSON.stringify([{ name: "fixture-crypto", version: 1, stores: [] }]),
        databaseCount: 1,
      });
    }
    seedCanonicalStorageRoot();
    const rotated = await resolveRotatedDevice();
    expect(rotated.rootDir).toBe(old.rootDir);
  },
);
it.each(["unknown", "different", "ambiguous"])("rejects sibling device: %s", async (identity) => {
  const old = canonicalRoot("secret-token-old");
  fs.mkdirSync(old.rootDir, { recursive: true });
  if (identity === "different") {
    seedStorageMeta(old.rootDir, storageMeta(old.tokenHash, { deviceId: "OLDDEVICE" }));
  }
  const canonical = canonicalRoot("secret-token-new");
  seedStorageMeta(
    canonical.rootDir,
    identity === "unknown"
      ? { accessTokenHash: canonical.tokenHash }
      : storageMeta(canonical.tokenHash, { deviceId: "NEWDEVICE" }),
  );
  const resolved = await resolvePaths({
    accessToken: "secret-token-new",
    deviceId: identity === "unknown" ? undefined : "NEWDEVICE",
  });
  expectSelected(resolved, canonical);
  expect(resolved.rootDir).not.toBe(old.rootDir);
});
it.each([true, false])("keeps backfilled roots sticky only when claimed: %s", async (claimed) => {
  const canonical = seedCanonicalStorageRoot("secret-token-new", { deviceId: null });
  if (claimed) {
    expect(await claimCurrentTokenStorageState(canonical)).toBe(true);
  }
  const old = seedCanonicalStorageRoot("secret-token-old");
  fs.mkdirSync(path.join(old.rootDir, "crypto"), { recursive: true });
  await repairCurrentTokenStorageMetaDeviceId({
    ...defaultAuth,
    accessToken: "secret-token-new",
    accountId: "default",
    deviceId: "DEVICE123",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  if (claimed) {
    expect(readStorageMeta(canonical.rootDir)).toMatchObject({ deviceId: "DEVICE123" });
    const startupPaths = await resolvePaths({ accessToken: "secret-token-new" });
    expect(startupPaths.rootDir).toBe(canonical.rootDir);
  }
  const restartedPaths = await resolveRotatedDevice();
  expect(restartedPaths.rootDir).toBe((claimed ? canonical : old).rootDir);
});
const storageFor = (auth = defaultAuth) => resolveMatrixAccountStorageRoot({ ...auth, stateDir });
const readState = (open: typeof openMatrixStorageMetaStoreOptions, root: string) =>
  getMatrixRuntime().state.openKeyedStore(open(root)).lookup("current");
function seedMetadata(auth: typeof defaultAuth & { accountId?: string; deviceId?: string }) {
  const storage = storageFor(auth);
  const { homeserver, userId, accountId = "default", deviceId = "DEVICE123" } = auth;
  seedStorageMeta(
    storage.rootDir,
    storageMeta(storage.tokenHash, {
      homeserver,
      userId,
      accountId,
      deviceId,
      currentTokenStateClaimed: true,
    }),
  );
}
async function seedCursor(root: string, token: string, clean: boolean) {
  const store = await SqliteBackedMatrixSyncStore.create(root);
  await store.setSyncData({
    next_batch: token,
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    account_data: { events: [] },
  });
  if (clean) {
    store.markCleanShutdown();
  }
  await store.flush();
}
async function acquire(auth: ReturnType<typeof authFor>, role?: "monitor") {
  const lease = await acquireSharedMatrixClient({ auth, role });
  leases.push(lease);
  return lease;
}
it.each([
  { encryption: true, clean: false, expectedClean: false },
  { encryption: true, clean: true, expectedClean: true },
  { encryption: false, clean: false, expectedClean: true },
])("keeps cursor: $encryption/$clean", async ({ encryption, clean, expectedClean }) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storage = storageFor();
  await seedCursor(storage.rootDir, "original-cursor", clean);
  const cfg = { channels: { matrix: { ...clientAuth, encryption } } };
  await withResolvedRuntimeMatrixClient({ cfg, readiness: "none" }, async () => undefined);
  const reloaded = await SqliteBackedMatrixSyncStore.create(storage.rootDir);
  expect(await reloaded.getSavedSyncToken()).toBe("original-cursor");
  expect(reloaded.hasSavedSyncFromCleanShutdown()).toBe(expectedClean);
});
it.each(["fresh", "rotated", "sqlite-crypto"])("persists %s without host SQL", async (rootKind) => {
  const seeded = storageFor();
  if (rootKind !== "fresh") {
    seedMetadata(defaultAuth);
    await seedCursor(seeded.rootDir, "saved-cursor", true);
  }
  if (rootKind === "sqlite-crypto") {
    stateStore(openMatrixRecoveryKeyStoreOptions(seeded.rootDir)).register("current", recoveryKey);
    stateStore(julyLegacyCryptoStoreOptions(seeded.rootDir)).register("current", migration);
  }
  await closeOpenClawStateDatabaseAsync();
  const observation = observeHostDataSql();
  try {
    if (rootKind === "fresh") {
      expect(fs.existsSync(path.join(seeded.rootDir, "state", "openclaw.sqlite"))).toBe(false);
    }
    const client = await createMatrixClient({
      ...clientAuth,
      accessToken: rootKind === "rotated" ? "rotated-token" : defaultAuth.accessToken,
    });
    const restoredCursors: string[] = [];
    const disposeIngress = await client.bindSyncIngress(async (sync) => {
      restoredCursors.push(sync.next_batch);
    });
    disposeIngress();
    expect(restoredCursors).toEqual(rootKind === "fresh" ? [] : ["saved-cursor"]);
    expect(fs.existsSync(path.join(seeded.rootDir, "bot-storage.json"))).toBe(false);
    expect(await readState(openMatrixStorageMetaStoreOptions, seeded.rootDir)).toMatchObject(
      storageMeta(seeded.tokenHash),
    );
    if (rootKind === "sqlite-crypto") {
      await expect(
        readState(openMatrixRecoveryKeyStoreOptions, seeded.rootDir),
      ).resolves.toMatchObject({ privateKeyBase64: Buffer.alloc(32, 7).toString("base64") });
      await expect(readState(julyLegacyCryptoStoreOptions, seeded.rootDir)).resolves.toMatchObject({
        restoreStatus: "pending",
      });
    }
    await client.stopWithoutPersist();
    const store = await SqliteBackedMatrixSyncStore.create(seeded.rootDir);
    expect(store.hasSavedSyncFromCleanShutdown()).toBe(rootKind !== "fresh");
    await store.setSyncData({
      next_batch: "claimed-token",
      rooms: { join: {}, invite: {}, leave: {}, knock: {} },
      account_data: { events: [] },
    });
    await store.flush();
    expect(await readState(openMatrixStorageMetaStoreOptions, seeded.rootDir)).toMatchObject({
      currentTokenStateClaimed: true,
    });
    await store.deleteAllData();
    await store.freezeSyncCursorPersistence();
    await closeOpenClawStateDatabaseAsync();
    const deleted = await SqliteBackedMatrixSyncStore.create(seeded.rootDir);
    expect(deleted.hasSavedSync()).toBe(false);
    expect(deleted.getSyncToken()).toBeNull();
    await closeOpenClawStateDatabaseAsync();
    for (const method of observation.calls) {
      expect(method).not.toHaveBeenCalled();
    }
  } finally {
    observation.restore();
  }
});
it.each([
  ["transport policy", { allowPrivateNetwork: true }, true],
  ["rotated token", { accessToken: "rotated-token" }, true],
  ["encryption toggle", { encryption: true }, true],
  ["distinct device", { accessToken: "another-device-token", deviceId: "ANOTHER-DEVICE" }, false],
] as const)("admits %s storage generation", async (_name, overrides, sharesStore) => {
  const auth = authFor("default");
  seedMetadata(auth);
  await closeOpenClawStateDatabaseAsync();
  const changed = { ...auth, ...overrides };
  const monitor = await acquire(auth, "monitor");
  const compatible = await acquire(auth);
  expect(compatible.client).toBe(monitor.client);
  await compatible.release();
  expect(monitor.abortSignal.aborted).toBe(false);
  if (sharesStore) {
    await expect(acquire(changed)).rejects.toMatchObject({
      code: "MATRIX_ACCOUNT_RESTARTING",
      retryable: true,
    });
    await monitor.release({ mode: "discard" });
  }
  const replacement = await acquire(changed);
  expect(replacement.client).not.toBe(monitor.client);
  if (!sharesStore) {
    expect(monitor.abortSignal.aborted).toBe(false);
  }
});
it.each(["recovery-key.json", "storage-meta.json"])("preserves retired %s", async (filename) => {
  const storage = storageFor();
  fs.mkdirSync(storage.rootDir, { recursive: true });
  const sourcePath = path.join(storage.rootDir, filename);
  const source = Buffer.from(JSON.stringify({ retained: true }));
  fs.writeFileSync(sourcePath, source);
  await expect(createMatrixClient(clientAuth)).rejects.toThrow("Install OpenClaw 2026.9.5");
  expect(fs.readFileSync(sourcePath)).toEqual(source);
  expect(fs.existsSync(path.join(storage.rootDir, "state"))).toBe(false);
});
