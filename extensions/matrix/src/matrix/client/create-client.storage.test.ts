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
import { MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME } from "../crypto-state-store.js";
import { createMatrixClient } from "./create-client.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
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

  function setupStateDir() {
    const stateDir = tempDirs.make("openclaw-matrix-factory-");
    installMatrixTestRuntime({
      stateDir,
      logging: { getChildLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
    });
    return stateDir;
  }
  function seedStorageMeta(rootDir: string, value: Record<string, unknown>) {
    createPluginStateSyncKeyedStoreForTests(
      "matrix",
      openMatrixStorageMetaStoreOptions(rootDir),
    ).register("current", value);
  }
  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value));
  }
  it.each(["fresh", "canonical", "rotated", "legacy-import"])(
    "restores the %s token root through the client factory without host SQLite",
    async (rootKind) => {
      const stateDir = setupStateDir();
      const seeded = resolveMatrixAccountStorageRoot({
        ...defaultStorageAuth,
        stateDir,
      });
      if (rootKind !== "fresh") {
        seedStorageMeta(seeded.rootDir, {
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
      if (rootKind === "legacy-import") {
        writeJson(seeded.rootDir, "recovery-key.json", {
          version: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        });
        writeJson(seeded.rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME, {
          version: 1,
          accountId: "default",
          roomKeyCounts: null,
          restoreStatus: "pending",
        });
      }
      await closeOpenClawStateDatabaseAsync();
      const observation = observeHostDataSql();
      const sql = observation.calls;
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
        if (rootKind === "legacy-import") {
          for (const filename of ["recovery-key.json", MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME]) {
            expect(fs.existsSync(path.join(seeded.rootDir, filename))).toBe(false);
            expect(fs.existsSync(path.join(seeded.rootDir, `${filename}.migrated`))).toBe(true);
          }
        }
        await client.stopWithoutPersist();
        await closeOpenClawStateDatabaseAsync();
        console.log(
          "matrix-storage-factory host SQL",
          rootKind,
          sql.map((method) => method.mock.calls.length),
        );
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        observation.restore();
      }
    },
  );
});
