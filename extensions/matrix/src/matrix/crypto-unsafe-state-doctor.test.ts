import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerMatrixDoctorCommands } from "../cli-doctor.js";
import { getMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  openMatrixIdbSnapshotStoreOptions,
  writeMatrixIdbSnapshotJson,
} from "./crypto-state-store.js";
import {
  listMatrixCryptoUnsafeState,
  recoverMatrixCryptoUnsafeState,
} from "./crypto-unsafe-state-doctor.js";
import { acquireMatrixCryptoStoreOwnership } from "./sdk/crypto-store-ownership.js";

let stateDir: string;
let storageRootDir: string;
let snapshotPath: string;
let markerPath: string;

const database = { name: "crypto", version: 1, stores: [] };
const keyStore = { name: "keys", keyPath: null, autoIncrement: false, indexes: [] };
const keysSnapshot = (records: unknown[], indexes: unknown[] = []) => [
  { ...database, stores: [{ ...keyStore, records, indexes }] },
];
const recover = (acceptSnapshotRollback = true) =>
  recoverMatrixCryptoUnsafeState({ storageRootDir, acceptSnapshotRollback });
const inspect = () => listMatrixCryptoUnsafeState(stateDir);
function writeSnapshot(root = storageRootDir, databases: unknown[] = [database]) {
  return writeMatrixIdbSnapshotJson({
    storageRootDir: root,
    snapshotJson: JSON.stringify(databases),
    databaseCount: databases.length,
  });
}
function snapshotStore() {
  return getMatrixRuntime().state.openKeyedStoreV2<Record<string, unknown>>(
    openMatrixIdbSnapshotStoreOptions(storageRootDir),
  );
}
function doctor() {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const command = new Command();
  registerMatrixDoctorCommands(command);
  return {
    recover: () =>
      command.parseAsync(
        ["doctor", "recover", "--account", "default", "--accept-snapshot-rollback"],
        { from: "user" },
      ),
    inspect: async () => {
      await command.parseAsync(["doctor", "inspect", "--json"], { from: "user" });
      return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    },
  };
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-unsafe-doctor-"));
  storageRootDir = path.join(stateDir, "matrix/accounts/default/example.org__bot/0123456789abcdef");
  await fs.mkdir(storageRootDir, { recursive: true });
  snapshotPath = path.join(storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
  markerPath = `${snapshotPath}.owner.poisoned`;
  installMatrixTestRuntime({ stateDir });
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetFileLockStateForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["default", "account"])(
  "inspects and recovers a missing guard for a sealed %s snapshot through the Doctor CLI",
  async (layout) => {
    const root = layout === "default" ? path.join(stateDir, "matrix") : storageRootDir;
    const snapshot = path.join(root, MATRIX_IDB_SNAPSHOT_FILENAME);
    const guard = `${snapshot}.owner.poisoned`;
    await fs.writeFile(guard, "unsafe\n");
    await writeSnapshot(root);
    const cli = doctor();
    expect(await cli.inspect()).toEqual({ blocked: [{ account: "default", rootDir: root }] });
    await cli.recover();
    expect((await fs.stat(guard)).isFile()).toBe(true);
    expect(await cli.inspect()).toEqual({ blocked: [] });

    await fs.unlink(guard);
    expect(await cli.inspect()).toEqual({
      blocked: [{ account: "default", rootDir: root }],
    });
    await cli.recover();
    expect((await fs.stat(guard)).isFile()).toBe(true);
    expect(await inspect()).toEqual([]);
    const owner = await acquireMatrixCryptoStoreOwnership(snapshot);
    await owner.release();
  },
);

it("inspects refusal without clearing it and requires explicit rollback acceptance", async () => {
  await fs.writeFile(markerPath, "unsafe\n");
  expect(await inspect()).toEqual([storageRootDir]);
  await expect(recover(false)).rejects.toThrow("explicit");
  await expect(recover()).rejects.toThrow("absent");
  expect(await inspect()).toEqual([storageRootDir]);
});

it("does not report an armed marker while its crypto owner is live", async () => {
  const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
  try {
    await owner.armUnsafeState();
    expect(await inspect()).toEqual([]);
  } finally {
    await owner.release();
  }
  expect(await inspect()).toEqual([storageRootDir]);
});

it("refuses recovery while a live owner holds the crypto store", async () => {
  await fs.writeFile(markerPath, "unsafe\n");
  const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath).catch(() => null);
  // The normal owner correctly refuses an existing marker; use the Doctor lock itself.
  expect(owner).toBeNull();
  await writeSnapshot();
  const { withMatrixCryptoStoreRecoveryLock } = await import("./sdk/crypto-store-ownership.js");
  await withMatrixCryptoStoreRecoveryLock(snapshotPath, async () => {
    await expect(recover()).rejects.toThrow();
    expect(await inspect()).toEqual([]);
  });
});

it("clears refusal only after validating the canonical SQLite snapshot", async () => {
  await fs.writeFile(markerPath, "unsafe\n");
  await writeSnapshot();
  const store = snapshotStore();
  const meta = await store.lookup("current:meta");
  if (!meta) {
    throw new Error("Snapshot fixture has no metadata");
  }
  await store.register("current:meta", { ...meta, digest: "incorrect" });
  const corruptRows = await store.entries();
  await expect(recover()).rejects.toMatchObject({ code: "matrix-idb-snapshot-invalid" });
  expect(await fs.readFile(markerPath, "utf8")).toBe("unsafe\n");
  expect(await store.entries()).toEqual(corruptRows);
  await store.register("current:meta", meta);
  await recover();
  expect(await inspect()).toEqual([]);
  const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
  await owner.release();
});

it.each([
  ["duplicate database names", [database, database]],
  ["invalid record keys", keysSnapshot([{ key: {}, value: "synthetic" }])],
  [
    "unique index conflicts",
    keysSnapshot(
      [
        { key: "first", value: { name: "same" } },
        { key: "second", value: { name: "same" } },
      ],
      [{ name: "unique", keyPath: "name", unique: true, multiEntry: false }],
    ),
  ],
] satisfies [string, unknown[]][])(
  "refuses recovery for %s without changing durable state",
  async (_label, databases) => {
    await fs.writeFile(markerPath, "unsafe\n");
    await writeSnapshot(storageRootDir, databases);
    const store = snapshotStore();
    const rows = await store.entries();
    await expect(recover()).rejects.toThrow("cannot be replayed");
    expect(await fs.readFile(markerPath, "utf8")).toBe("unsafe\n");
    expect(await store.entries()).toEqual(rows);
    expect(await inspect()).toEqual([storageRootDir]);
  },
);
