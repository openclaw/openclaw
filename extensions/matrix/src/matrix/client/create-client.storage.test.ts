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
import { openMatrixRecoveryKeyStoreOptions } from "../crypto-state-store.js";
import { createMatrixClient } from "./create-client.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { julyLegacyCryptoStoreOptions } from "./legacy-crypto-state.test-support.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";

vi.mock("./config.js", () => ({
  resolveValidatedMatrixHomeserverUrl: async (url: string) => url,
}));

describe("Matrix client factory storage", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
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
