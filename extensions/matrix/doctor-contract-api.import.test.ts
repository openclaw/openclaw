import fs from "node:fs";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it, vi } from "vitest";
import {
  openMatrixSyncCacheStoreOptions,
  writeMatrixSyncCacheStateToStore,
} from "./src/matrix/client/sync-cache-state.js";
import {
  openMatrixIdbSnapshotStoreOptions,
  sealMatrixIdbSnapshotOwnerGeneration,
  writeMatrixIdbSnapshotJson,
} from "./src/matrix/crypto-state-store.js";
import { getMatrixRuntime } from "./src/runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

// Exercise real empty-state operations without materializing client runtimes.
vi.mock("matrix-js-sdk/lib/matrix.js", () => {
  throw new Error("Matrix SDK loaded by a Doctor migration");
});
vi.mock("fake-indexeddb", () => {
  throw new Error("IndexedDB runtime loaded by a Doctor migration");
});
vi.mock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
  throw new Error("Schema repair runtime loaded without an account database");
});
vi.mock("./src/matrix/client/storage.js", () => {
  throw new Error("Client storage loaded by an absent-state Doctor migration");
});
vi.mock("./src/account-selection.js", () => {
  throw new Error("Account topology loaded without legacy credential sources");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses retired JSON state without changing it or inspecting token-root archives", async () => {
  const stateDir = tempDirs.make("matrix-retired-state-");
  const filenames = [
    "thread-bindings.json",
    "startup-verification.json",
    "recovery-key.json",
    "legacy-crypto-migration.json",
    "crypto-idb-snapshot.json",
    "storage-meta.json",
    "inbound-dedupe.json",
  ];
  const matrixRoot = path.join(stateDir, "matrix");
  const sources = [
    matrixRoot,
    path.join(matrixRoot, "accounts", "default"),
    path.join(matrixRoot, "accounts", "ops", "matrix.example.org__bot", "0123456789abcdef"),
  ].flatMap((root) => filenames.map((filename) => path.join(root, filename)));
  const archives = filenames.map((filename) =>
    path.join(
      matrixRoot,
      "accounts",
      "ops",
      "matrix.example.org__bot",
      "sync-cache-backup",
      filename,
    ),
  );
  for (const file of [...sources, ...archives]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"retained":true}\n');
  }
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const migration = stateMigrations.find((entry) => entry.id === "matrix-account-sqlite-schema")!;
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("retired state must not open a store");
  });
  const params = {
    config: {},
    env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  for (const run of [migration.detectLegacyState, migration.migrateLegacyState]) {
    const result = run(params);
    await expect(result).rejects.toThrow("Install OpenClaw 2026.9.5");
    for (const file of sources) {
      await expect(result).rejects.toThrow(file);
    }
    for (const archive of archives) {
      await expect(result).rejects.not.toThrow(archive);
    }
  }
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
  for (const file of [...sources, ...archives]) {
    expect(fs.readFileSync(file, "utf8")).toBe('{"retained":true}\n');
  }
});

it("completes absent legacy-state checks without loading client runtimes", async () => {
  const stateDir = tempDirs.make("openclaw-matrix-doctor-import-");
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("absent legacy sources must not open a state store");
  });
  const params = {
    config: {},
    env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  for (const id of [
    "matrix-account-sqlite-schema",
    "matrix-crypto-unsafe-state",
    "matrix-sync-cache-json-to-plugin-state",
  ]) {
    const migration = stateMigrations.find((entry) => entry.id === id);
    if (!migration) {
      throw new Error(`Missing migration: ${id}`);
    }
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  }
  const inboundDedupe = stateMigrations.find(
    (entry) => entry.id === "matrix-inbound-dedupe-to-claimable-dedupe",
  )!;
  await expect(inboundDedupe.detectLegacyState(params)).resolves.toBeNull();
  const credentials = stateMigrations.find(
    (entry) => entry.id === "matrix-credentials-json-to-plugin-state",
  );
  if (!credentials) {
    throw new Error("Missing credential migration");
  }
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  const credentialsDir = path.join(stateDir, "credentials", "matrix");
  fs.mkdirSync(credentialsDir, { recursive: true });
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  fs.writeFileSync(path.join(credentialsDir, "unrelated.json"), "{}");
  fs.mkdirSync(path.join(credentialsDir, "credentials-ops.json"));
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
});

it.each([true, false])(
  "inspects populated canonical state through the Doctor context without initializing Matrix (guard present: %s)",
  async (guardPresent) => {
    const stateDir = tempDirs.make("matrix-doctor-canonical-");
    const root = path.join(
      stateDir,
      "matrix",
      "accounts",
      "ops",
      "matrix.example.org__bot",
      "0123456789abcdef",
    );
    const generation = "0123456789abcdef0123456789abcdef";
    const marker = path.join(root, "crypto-idb-snapshot.json.owner.poisoned");
    const stateRuntime = {
      openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreV2ForTests<T>("matrix", options, { assertCurrent() {} }),
    };
    await writeMatrixIdbSnapshotJson({
      storageRootDir: root,
      snapshotJson: '{"databases":[]}',
      databaseCount: 0,
      stateRuntime,
    });
    await sealMatrixIdbSnapshotOwnerGeneration(root, generation, stateRuntime);
    const openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("matrix", options);
    const snapshotStore = openPluginStateKeyedStore(openMatrixIdbSnapshotStoreOptions(root));
    const syncStore = openPluginStateKeyedStore(openMatrixSyncCacheStoreOptions(root));
    await writeMatrixSyncCacheStateToStore({
      storageRootDir: root,
      store: openPluginStateKeyedStore(openMatrixSyncCacheStoreOptions(root)),
      payload: {
        version: 1,
        cleanShutdown: false,
        savedSync: {
          nextBatch: "retained-cursor",
          accountData: [],
          roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
        },
      },
    });
    if (guardPresent) {
      fs.writeFileSync(marker, `${generation}\n`);
    }
    const snapshotBefore = await snapshotStore.entries();
    const syncBefore = await syncStore.entries();
    expect(() => getMatrixRuntime()).toThrow("Matrix runtime not initialized");
    const { stateMigrations } = await import("./doctor-contract-api.js");
    const migration = stateMigrations.find((entry) => entry.id === "matrix-crypto-unsafe-state")!;
    const params = {
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: { openPluginStateKeyedStore },
    };
    try {
      const detected = await migration.detectLegacyState(params);
      const migrated = await migration.migrateLegacyState(params);
      if (guardPresent) {
        expect(detected).toBeNull();
        expect(migrated).toEqual({ changes: [], warnings: [] });
      } else {
        expect(detected?.preview).toEqual([expect.stringContaining(root)]);
        expect(migrated).toEqual({ changes: [], warnings: [expect.stringContaining(root)] });
      }
      expect(await snapshotStore.entries()).toEqual(snapshotBefore);
      expect(await syncStore.entries()).toEqual(syncBefore);
      expect(fs.existsSync(marker)).toBe(guardPresent);
      if (guardPresent) {
        expect(fs.readFileSync(marker, "utf8")).toBe(`${generation}\n`);
      }
      expect(() => getMatrixRuntime()).toThrow("Matrix runtime not initialized");
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  },
);
