import fs from "node:fs";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { withResolvedRuntimeMatrixClient } from "../client-bootstrap.js";
import { openMatrixRecoveryKeyStoreOptions } from "../crypto-state-store.js";
import { createMatrixClient } from "./create-client.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { julyLegacyCryptoStoreOptions } from "./legacy-crypto-state.test-support.js";
import { acquireSharedMatrixClient, type SharedMatrixClientLease } from "./shared.js";
import { authFor } from "./shared.test-support.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  resolveValidatedMatrixHomeserverUrl: async (url: string) => url,
}));

let stateDir: string;
const leases: SharedMatrixClientLease[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.allSettled(leases.splice(0).map((lease) => lease.release({ mode: "discard" })));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const defaultStorageAuth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "secret-token",
};
const clientAuth = { ...defaultStorageAuth, deviceId: "DEVICE123" };
beforeEach(() => {
  resetPluginStateStoreForTests();
  stateDir = tempDirs.make("openclaw-matrix-factory-");
  installMatrixTestRuntime({ stateDir });
});

const storageFor = (auth = defaultStorageAuth) =>
  resolveMatrixAccountStorageRoot({ ...auth, stateDir });
const stateStore = (open: typeof openMatrixStorageMetaStoreOptions, root: string) =>
  createPluginStateSyncKeyedStoreForTests("matrix", open(root));
const readState = (open: typeof openMatrixStorageMetaStoreOptions, root: string) =>
  getMatrixRuntime().state.openKeyedStore(open(root)).lookup("current");

function seedMetadata(auth: typeof defaultStorageAuth & { accountId?: string; deviceId?: string }) {
  const storage = storageFor(auth);
  const { homeserver, userId, accountId = "default", deviceId = "DEVICE123" } = auth;
  stateStore(openMatrixStorageMetaStoreOptions, storage.rootDir).register("current", {
    homeserver,
    userId,
    accountId,
    deviceId,
    accessTokenHash: storage.tokenHash,
    currentTokenStateClaimed: true,
  });
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
  const lease = await acquireSharedMatrixClient({ auth, role, startClient: false });
  leases.push(lease);
  return lease;
}

it.each([
  { encryption: true, originallyClean: false, expectedClean: false },
  { encryption: true, originallyClean: true, expectedClean: true },
  { encryption: false, originallyClean: false, expectedClean: true },
])(
  "preserves cursor cleanliness for an unprepared control client: encryption=$encryption clean=$originallyClean",
  async ({ encryption, originallyClean, expectedClean }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storage = storageFor();
    await seedCursor(storage.rootDir, "original-cursor", originallyClean);
    const cfg = { channels: { matrix: { ...clientAuth, encryption } } };
    await withResolvedRuntimeMatrixClient({ cfg, readiness: "none" }, async () => undefined);
    const reloaded = await SqliteBackedMatrixSyncStore.create(storage.rootDir);
    expect(await reloaded.getSavedSyncToken()).toBe("original-cursor");
    expect(reloaded.hasSavedSyncFromCleanShutdown()).toBe(expectedClean);
  },
);
it.each(["fresh", "rotated", "sqlite-crypto"])(
  "restores the %s token root through the client factory without host SQLite",
  async (rootKind) => {
    installMatrixTestRuntime({
      stateDir,
      logging: { getChildLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
    });
    const seeded = storageFor();
    if (rootKind !== "fresh") {
      seedMetadata(defaultStorageAuth);
      await seedCursor(seeded.rootDir, "saved-cursor", true);
    }
    if (rootKind === "sqlite-crypto") {
      stateStore(openMatrixRecoveryKeyStoreOptions, seeded.rootDir).register("current", {
        version: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      });
      stateStore(julyLegacyCryptoStoreOptions, seeded.rootDir).register("current", {
        version: 1,
        accountId: "default",
        roomKeyCounts: null,
        restoreStatus: "pending",
      });
    }
    await closeOpenClawStateDatabaseAsync();
    const observation = observeHostDataSql();
    try {
      const client = await createMatrixClient({
        ...clientAuth,
        accessToken: rootKind === "rotated" ? "rotated-token" : defaultStorageAuth.accessToken,
      });
      const restoredCursors: string[] = [];
      const disposeIngress = await client.bindSyncIngress(async (sync) => {
        restoredCursors.push(sync.next_batch);
      });
      disposeIngress();
      expect(restoredCursors).toEqual(rootKind === "fresh" ? [] : ["saved-cursor"]);
      expect(await readState(openMatrixStorageMetaStoreOptions, seeded.rootDir)).toMatchObject({
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accessTokenHash: seeded.tokenHash,
        deviceId: "DEVICE123",
      });
      if (rootKind === "sqlite-crypto") {
        await expect(
          readState(openMatrixRecoveryKeyStoreOptions, seeded.rootDir),
        ).resolves.toMatchObject({ privateKeyBase64: Buffer.alloc(32, 7).toString("base64") });
        await expect(
          readState(julyLegacyCryptoStoreOptions, seeded.rootDir),
        ).resolves.toMatchObject({ restoreStatus: "pending" });
      }
      await client.stopWithoutPersist();
      await closeOpenClawStateDatabaseAsync();
      for (const method of observation.calls) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
    }
  },
);
it.each([
  ["transport policy", { allowPrivateNetwork: true }, true],
  ["rotated token", { accessToken: "rotated-token" }, true],
  ["encryption toggle", { encryption: true }, true],
  ["distinct device", { accessToken: "another-device-token", deviceId: "ANOTHER-DEVICE" }, false],
] as const)(
  "admits a %s generation only when its selected store is available",
  async (_name, overrides, sharesStore) => {
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
  },
);

it.each(["recovery-key.json", "storage-meta.json"])(
  "refuses retired %s before creating a client or changing state",
  async (filename) => {
    const storage = storageFor();
    fs.mkdirSync(storage.rootDir, { recursive: true });
    const sourcePath = path.join(storage.rootDir, filename);
    const source = Buffer.from(JSON.stringify({ retained: true }));
    fs.writeFileSync(sourcePath, source);
    await expect(createMatrixClient(clientAuth)).rejects.toThrow("Install OpenClaw 2026.9.5");
    expect(fs.readFileSync(sourcePath)).toEqual(source);
    expect(fs.existsSync(path.join(storage.rootDir, "state"))).toBe(false);
  },
);
