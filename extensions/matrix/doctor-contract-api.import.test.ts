import fs from "node:fs";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  accountStorageRoot,
  createContext,
  createMigrationParams,
  migrationById,
  syncCachePayload,
  writeSource,
} from "./doctor-contract-api.test-support.js";
import {
  type MatrixSyncCacheRecord,
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

const failImport = vi.hoisted(() => (name: string): never => {
  throw new Error(`${name} loaded by a Doctor migration`);
});
vi.mock("matrix-js-sdk/lib/matrix.js", () => failImport("Matrix SDK"));
vi.mock("fake-indexeddb", () => failImport("IndexedDB"));
// mock-isolation: These migration cases must fail if schema repair is loaded.
vi.mock("openclaw/plugin-sdk/doctor-repair-runtime", () => failImport("Schema repair"));
// mock-isolation: These migration cases must not initialize the Matrix client storage runtime.
vi.mock("./src/matrix/client/storage.js", () => failImport("Client storage"));
// mock-isolation: These migration cases must not resolve account topology.
vi.mock("./src/account-selection.js", () => failImport("Account topology"));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let params: ReturnType<typeof createMigrationParams>;
beforeEach(() => {
  stateDir = tempDirs.make("matrix-doctor-import-");
  params = createMigrationParams(stateDir);
  params.env = { ...params.env, HOME: stateDir };
  params.context = {
    readPluginStateEntriesInKeyRange: () => [],
    openPluginStateKeyedStore() {
      throw new Error("absent or retired state must not open a store");
    },
  };
});

const accountRoot = (token = "0123456789abcdef") => accountStorageRoot(stateDir, "ops", token);
const unchanged = { changes: [], warnings: [] };

it("refuses retired JSON state without changing it or inspecting token-root archives", async () => {
  const matrixRoot = path.join(stateDir, "matrix");
  const sources = [matrixRoot, path.join(matrixRoot, "accounts", "default"), accountRoot()].map(
    (root) => path.join(root, "recovery-key.json"),
  );
  const archive = path.join(accountRoot("sync-cache-backup"), "recovery-key.json");
  for (const file of [...sources, archive]) {
    writeSource(file, '{"retained":true}\n');
  }
  const migration = await migrationById("matrix-account-sqlite-schema");
  for (const run of [migration.detectLegacyState, migration.migrateLegacyState]) {
    const result = run(params);
    await expect(result).rejects.toThrow("Install OpenClaw 2026.9.5");
    for (const file of sources) {
      await expect(result).rejects.toThrow(file);
    }
    await expect(result).rejects.not.toThrow(archive);
  }
  for (const file of [...sources, archive]) {
    expect(fs.readFileSync(file, "utf8")).toBe('{"retained":true}\n');
  }
});

it("completes absent legacy-state checks without loading client runtimes", async () => {
  for (const id of [
    "matrix-account-sqlite-schema",
    "matrix-crypto-unsafe-state",
    "matrix-sync-cache-json-to-plugin-state",
    "matrix-replay-guard-to-ingress",
  ]) {
    const migration = await migrationById(id);
    expect(await migration.detectLegacyState(params)).toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
  }
  const inboundDedupe = await migrationById("matrix-inbound-dedupe-to-claimable-dedupe");
  await expect(inboundDedupe.detectLegacyState(params)).resolves.toBeNull();
  const credentials = await migrationById("matrix-credentials-json-to-plugin-state");
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  const credentialsDir = path.join(stateDir, "credentials", "matrix");
  fs.mkdirSync(credentialsDir, { recursive: true });
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  fs.writeFileSync(path.join(credentialsDir, "unrelated.json"), "{}");
  fs.mkdirSync(path.join(credentialsDir, "credentials-ops.json"));
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
});

it.each([true, false])(
  "inspects populated canonical state through the Doctor context without initializing Matrix (guard present: %s)",
  async (guardPresent) => {
    const root = accountRoot();
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
    const { openPluginStateKeyedStore } = createContext();
    const snapshotStore = openPluginStateKeyedStore(openMatrixIdbSnapshotStoreOptions(root));
    const syncStore = openPluginStateKeyedStore<MatrixSyncCacheRecord>(
      openMatrixSyncCacheStoreOptions(root),
    );
    await writeMatrixSyncCacheStateToStore({
      storageRootDir: root,
      store: syncStore,
      payload: syncCachePayload("retained-cursor", false),
    });
    if (guardPresent) {
      fs.writeFileSync(marker, `${generation}\n`);
    }
    const readState = async () => ({
      snapshot: await snapshotStore.entries(),
      sync: await syncStore.entries(),
      marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
    });
    const before = await readState();
    expect(before.marker).toBe(guardPresent ? `${generation}\n` : null);
    const migration = await migrationById("matrix-crypto-unsafe-state");
    params.context = { openPluginStateKeyedStore };
    try {
      const detected = await migration.detectLegacyState(params);
      expect(detected).toEqual(guardPresent ? null : { preview: [expect.stringContaining(root)] });
      expect(await migration.migrateLegacyState(params)).toEqual({
        changes: [],
        warnings: guardPresent ? [] : [expect.stringContaining(root)],
      });
      expect(await readState()).toEqual(before);
      expect(() => getMatrixRuntime()).toThrow("Matrix runtime not initialized");
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  },
);
