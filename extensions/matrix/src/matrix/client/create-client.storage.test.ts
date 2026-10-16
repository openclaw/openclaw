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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { withResolvedRuntimeMatrixClient } from "../client-bootstrap.js";
import { openMatrixRecoveryKeyStoreOptions } from "../crypto-state-store.js";
import { createMatrixClient } from "./create-client.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { julyLegacyCryptoStoreOptions } from "./legacy-crypto-state.test-support.js";
import { acquireSharedMatrixClient } from "./shared.js";
import type { SharedMatrixClientLease } from "./shared.js";
import { authFor } from "./shared.test-support.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  resolveValidatedMatrixHomeserverUrl: async (url: string) => url,
}));

describe("Matrix client factory storage", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
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
  beforeEach(() => resetPluginStateStoreForTests());

  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value));
  }

  it.each([
    { encryption: true, originallyClean: false, expectedClean: false },
    { encryption: true, originallyClean: true, expectedClean: true },
    { encryption: false, originallyClean: false, expectedClean: true },
  ])(
    "preserves cursor cleanliness for an unprepared control client: encryption=$encryption clean=$originallyClean",
    async ({ encryption, originallyClean, expectedClean }) => {
      const stateDir = tempDirs.make("openclaw-matrix-control-cursor-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      installMatrixTestRuntime({ stateDir });
      const storage = resolveMatrixAccountStorageRoot({ ...defaultStorageAuth, stateDir });
      const seeded = await SqliteBackedMatrixSyncStore.create(storage.rootDir);
      await seeded.setSyncData({
        next_batch: "original-cursor",
        rooms: { join: {}, invite: {}, leave: {}, knock: {} },
        account_data: { events: [] },
      });
      if (originallyClean) {
        seeded.markCleanShutdown();
      }
      await seeded.flush();
      const cfg = {
        channels: {
          matrix: { ...defaultStorageAuth, deviceId: "DEVICE123", encryption },
        },
      };
      await withResolvedRuntimeMatrixClient({ cfg, readiness: "none" }, async (client) => {
        expect(client.hasPersistedSyncState()).toBe(originallyClean);
      });
      const reloaded = await SqliteBackedMatrixSyncStore.create(storage.rootDir);
      expect(await reloaded.getSavedSyncToken()).toBe("original-cursor");
      expect(reloaded.hasSavedSyncFromCleanShutdown()).toBe(expectedClean);
    },
  );
  it.each(["fresh", "rotated", "sqlite-crypto"])(
    "restores the %s token root through the client factory without host SQLite",
    async (rootKind) => {
      const stateDir = tempDirs.make("openclaw-matrix-factory-");
      installMatrixTestRuntime({
        stateDir,
        logging: { getChildLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
      });
      const seeded = resolveMatrixAccountStorageRoot({
        ...defaultStorageAuth,
        stateDir,
      });
      if (rootKind !== "fresh") {
        createPluginStateSyncKeyedStoreForTests(
          "matrix",
          openMatrixStorageMetaStoreOptions(seeded.rootDir),
        ).register("current", {
          ...defaultStorageAuth,
          accountId: "default",
          accessTokenHash: seeded.tokenHash,
          deviceId: "DEVICE123",
          currentTokenStateClaimed: true,
        });
        const syncStore = await SqliteBackedMatrixSyncStore.create(seeded.rootDir);
        await syncStore.setSyncData({
          next_batch: "saved-cursor",
          rooms: { join: {}, invite: {}, leave: {}, knock: {} },
          account_data: { events: [] },
        });
        syncStore.markCleanShutdown();
        await syncStore.flush();
      }
      if (rootKind === "sqlite-crypto") {
        createPluginStateSyncKeyedStoreForTests(
          "matrix",
          openMatrixRecoveryKeyStoreOptions(seeded.rootDir),
        ).register("current", {
          version: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        });
        createPluginStateSyncKeyedStoreForTests(
          "matrix",
          julyLegacyCryptoStoreOptions(seeded.rootDir),
        ).register("current", {
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
          ...defaultStorageAuth,
          accessToken: rootKind === "rotated" ? "rotated-token" : defaultStorageAuth.accessToken,
          deviceId: "DEVICE123",
        });
        expect(client.hasPersistedSyncState()).toBe(rootKind !== "fresh");
        expect(
          await getMatrixRuntime()
            .state.openKeyedStore(openMatrixStorageMetaStoreOptions(seeded.rootDir))
            .lookup("current"),
        ).toMatchObject({
          homeserver: defaultStorageAuth.homeserver,
          userId: defaultStorageAuth.userId,
          accessTokenHash: seeded.tokenHash,
          deviceId: "DEVICE123",
        });
        if (rootKind === "sqlite-crypto") {
          await expect(
            getMatrixRuntime()
              .state.openKeyedStore(openMatrixRecoveryKeyStoreOptions(seeded.rootDir))
              .lookup("current"),
          ).resolves.toMatchObject({ privateKeyBase64: Buffer.alloc(32, 7).toString("base64") });
          await expect(
            getMatrixRuntime()
              .state.openKeyedStore(julyLegacyCryptoStoreOptions(seeded.rootDir))
              .lookup("current"),
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
  it.each(["transport policy", "rotated token", "encryption toggle"])(
    "refuses an active %s generation sharing the selected store until explicit retirement",
    async (change) => {
      const stateDir = tempDirs.make("openclaw-matrix-generation-");
      installMatrixTestRuntime({ stateDir });
      const auth = authFor("default");
      const seeded = resolveMatrixAccountStorageRoot({ ...auth, stateDir });
      createPluginStateSyncKeyedStoreForTests(
        "matrix",
        openMatrixStorageMetaStoreOptions(seeded.rootDir),
      ).register("current", {
        homeserver: auth.homeserver,
        userId: auth.userId,
        accountId: auth.accountId,
        accessTokenHash: seeded.tokenHash,
        deviceId: auth.deviceId,
        currentTokenStateClaimed: true,
      });
      await closeOpenClawStateDatabaseAsync();
      const changed = {
        ...auth,
        ...(change === "transport policy" ? { allowPrivateNetwork: true } : {}),
        ...(change === "rotated token" ? { accessToken: "rotated-token" } : {}),
        ...(change === "encryption toggle" ? { encryption: true } : {}),
      };
      const leases: SharedMatrixClientLease[] = [];
      try {
        const monitor = await acquireSharedMatrixClient({
          auth,
          role: "monitor",
          startClient: false,
        });
        leases.push(monitor);
        const compatible = await acquireSharedMatrixClient({ auth, startClient: false });
        leases.push(compatible);
        expect(compatible.client).toBe(monitor.client);
        await compatible.release();
        await expect(
          acquireSharedMatrixClient({ auth: changed, startClient: false }).then((lease) => {
            leases.push(lease);
            return lease;
          }),
        ).rejects.toMatchObject({
          code: "MATRIX_ACCOUNT_RESTARTING",
          retryable: true,
        });
        expect(monitor.abortSignal.aborted).toBe(false);
        await monitor.release({ mode: "discard" });
        const replacement = await acquireSharedMatrixClient({ auth: changed, startClient: false });
        leases.push(replacement);
        expect(replacement.client).not.toBe(monitor.client);
      } finally {
        await Promise.allSettled(leases.map((lease) => lease.release({ mode: "discard" })));
      }
    },
  );

  it("admits a distinct selected device store while the prior generation remains active", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-distinct-generation-");
    installMatrixTestRuntime({ stateDir });
    const auth = authFor("default");
    const seeded = resolveMatrixAccountStorageRoot({ ...auth, stateDir });
    createPluginStateSyncKeyedStoreForTests(
      "matrix",
      openMatrixStorageMetaStoreOptions(seeded.rootDir),
    ).register("current", {
      homeserver: auth.homeserver,
      userId: auth.userId,
      accountId: auth.accountId,
      accessTokenHash: seeded.tokenHash,
      deviceId: auth.deviceId,
      currentTokenStateClaimed: true,
    });
    await closeOpenClawStateDatabaseAsync();
    const leases: SharedMatrixClientLease[] = [];
    try {
      const first = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
      leases.push(first);
      const second = await acquireSharedMatrixClient({
        auth: { ...auth, accessToken: "another-device-token", deviceId: "ANOTHER-DEVICE" },
        startClient: false,
      });
      leases.push(second);
      expect(second.client).not.toBe(first.client);
      expect(first.abortSignal.aborted).toBe(false);
    } finally {
      await Promise.allSettled(leases.map((lease) => lease.release({ mode: "discard" })));
    }
  });

  it.each(["recovery-key.json", "storage-meta.json"])(
    "refuses retired %s before creating a client or changing state",
    async (filename) => {
      const stateDir = tempDirs.make("openclaw-matrix-retired-factory-");
      installMatrixTestRuntime({ stateDir });
      const storage = resolveMatrixAccountStorageRoot({ ...defaultStorageAuth, stateDir });
      fs.mkdirSync(storage.rootDir, { recursive: true });
      const sourcePath = path.join(storage.rootDir, filename);
      writeJson(storage.rootDir, filename, { retained: true });
      const source = fs.readFileSync(sourcePath);
      await expect(
        createMatrixClient({ ...defaultStorageAuth, deviceId: "DEVICE123" }),
      ).rejects.toThrow("Install OpenClaw 2026.9.5");
      expect(fs.readFileSync(sourcePath)).toEqual(source);
      expect(fs.existsSync(path.join(storage.rootDir, "state"))).toBe(false);
    },
  );
});
