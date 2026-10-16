import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import { runOpenClawAgentPathWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import {
  authProfileSourceExists,
  captureAuthProfileFileIdentity,
  readAuthProfileDatabaseIdentity,
  noteAuthProfileFileWrite,
  refreshAuthProfileFileState,
  registerAuthProfileFileChangeListener,
} from "./file-state.js";
import { runtimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

afterEach(async () => {
  runtimeAuthProfileRowsCache.clear();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.skipIf(process.platform === "win32")(
  "keeps worker WAL observations off row children while retiring replaced credential files",
  async () => {
    const directory = temporary.make("auth-file-native-worker-");
    const worker = new Worker(
      `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const path = require("node:path");
      const { syncBuiltinESMExports } = require("node:module");
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      let spawned = 0;
      require("node:child_process").spawn = () => {
        spawned += 1;
        throw new Error("Worker auth observation requested a row child");
      };
      fs.watch = () => { throw new Error("synthetic unavailable watcher"); };
      syncBuiltinESMExports();
      (async () => {
        const { register } = await import(workerData.loader);
        const unregister = register();
        const files = await import(workerData.files);
        const snapshots = await import(workerData.snapshots);
        const { runtimeAuthProfileRowsCache } = await import(workerData.cache);
        const { acquireAuthProfileReadDatabase } = await import(workerData.pool);
        const { readAuthProfileRowsReadOnly } = await import(workerData.rows);
        const { openSqliteReadOnlyDatabase } = await import(workerData.opener);
        const { runInDetachedAsyncContext } = await import(workerData.detached);
        const { closeOpenClawStateDatabaseAsync } = await import(workerData.cleanup);
        const databasePath = path.join(workerData.directory, "openclaw-agent.sqlite");
        const store = (key) => ({
          version: 1,
          profiles: { fixture: { type: "api_key", provider: "fixture", key } },
        });
        const create = (pathname, key) => {
          const db = new DatabaseSync(pathname);
          db.exec(
            "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);" +
            "CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);" +
            "INSERT INTO auth_profile_state VALUES ('primary', '{}');"
          );
          db.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?)").run(JSON.stringify(store(key)));
          return db;
        };
        const writer = create(databasePath, "worker-original");
        try {
          writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
          const acquired = acquireAuthProfileReadDatabase(databasePath, openSqliteReadOnlyDatabase);
          assert.equal(acquired.status, "readable");
          const reader = acquired.db;
          const owner = { databasePath, sharedDatabasePath: databasePath, location: "legacy-main" };
          snapshots.setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
            store("worker-original"), databasePath, workerData.directory, owner
          );
          snapshots.recordRuntimeAuthProfilePersistedStore(databasePath, store("worker-original"));
          const changes = [];
          const unsubscribe = files.registerAuthProfileFileChangeListener((change) => changes.push(change));
          try {
            writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{"fixture":"fixture"}}');
            assert.ok(fs.statSync(databasePath + "-wal").size > 0);
            await runInDetachedAsyncContext(files.refreshAuthProfileFileState);
            assert.equal(spawned, 0, "WAL-only observation must not launch an auth row child");
            assert.equal(runtimeAuthProfileRowsCache.hasSource(databasePath), false);
            assert.equal(reader.isOpen, true);
            assert.deepEqual(snapshots.getRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath), store("worker-original"));

            writer.close();
            const replacement = databasePath + ".replacement";
            create(replacement, "worker-replacement").close();
            fs.renameSync(replacement, databasePath);
            await runInDetachedAsyncContext(files.refreshAuthProfileFileState);
            assert.ok(changes.some((change) => change.identityChanged));
            assert.equal(reader.isOpen, false);
            assert.equal(snapshots.getRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath), undefined);
            assert.deepEqual(readAuthProfileRowsReadOnly(databasePath, openSqliteReadOnlyDatabase).store, {
              status: "readable", raw: store("worker-replacement")
            });
            assert.equal(spawned, 0);
          } finally {
            unsubscribe();
          }
        } finally {
          if (writer.isOpen) writer.close();
          snapshots.clearRuntimeAuthProfileStoreSnapshots();
          await closeOpenClawStateDatabaseAsync();
          unregister();
        }
        parentPort.postMessage("worker observations verified");
        parentPort.close();
      })().catch((error) => { throw error; });
      `,
      {
        eval: true,
        execArgv: [],
        env: { ...process.env, OPENCLAW_STATE_DIR: directory },
        workerData: {
          directory,
          loader: import.meta.resolve("tsx/esm/api"),
          files: new URL("./file-state.ts", import.meta.url).href,
          snapshots: new URL("./runtime-snapshots.ts", import.meta.url).href,
          cache: new URL("./runtime-persisted-rows.ts", import.meta.url).href,
          pool: new URL("./sqlite-read-pool.ts", import.meta.url).href,
          rows: new URL("./sqlite-json.ts", import.meta.url).href,
          opener: new URL("../../infra/sqlite-snapshot-source.ts", import.meta.url).href,
          detached: new URL("../../shared/detached-async-context.ts", import.meta.url).href,
          cleanup: new URL("../../state/openclaw-state-db-cache.ts", import.meta.url).href,
        },
      },
    );
    try {
      const [[result], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
      expect(code).toBe(0);
      expect(result).toBe("worker observations verified");
    } finally {
      await worker.terminate();
    }
  },
);

it("rejects a swapped database before a privileged write even before observation runs", async () => {
  const directory = temporary.make("auth-file-write-admission-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  fs.writeFileSync(databasePath, "original synthetic database");
  captureAuthProfileFileIdentity(databasePath);
  const write = vi.fn();
  await runOpenClawAgentPathWriteAdmission(databasePath, async (_identity, assertCurrent) => {
    const replacement = `${databasePath}.replacement`;
    fs.writeFileSync(replacement, "replacement synthetic database");
    fs.renameSync(replacement, databasePath);
    await Promise.resolve();
    expect(() => {
      assertCurrent();
      write();
    }).toThrow("database target changed");
  });
  expect(write).not.toHaveBeenCalled();
});

it("publishes a first owner write immediately and keeps same-file writes from revoking identity", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const directory = temporary.make("auth-file-write-through-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).toMatch(/^path:/);
  fs.writeFileSync(databasePath, "created synthetic database");
  noteAuthProfileFileWrite(databasePath);
  const captured = captureAuthProfileFileIdentity(databasePath);
  expect(captured.identity?.key).toMatch(/^file:/);
  const changed = new Promise<void>((resolve) => {
    const unsubscribe = registerAuthProfileFileChangeListener(({ directory: observed }) => {
      if (observed === directory) {
        unsubscribe();
        resolve();
      }
    });
  });
  fs.writeFileSync(databasePath, "session-only write in the same file");
  await vi.advanceTimersByTimeAsync(30_000);
  await changed;
  expect(() => captured.assertCurrent()).not.toThrow();
});

it("publishes a first owner write to previously admitted directory aliases", () => {
  const root = temporary.make("auth-file-alias-write-through-");
  const directory = path.join(root, "owner");
  const alias = path.join(root, "alias");
  fs.mkdirSync(directory);
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  const aliasPath = path.join(alias, "openclaw-agent.sqlite");
  const before = readAuthProfileDatabaseIdentity(aliasPath);
  expect(before?.key).toMatch(/^path:/);

  fs.writeFileSync(databasePath, "created synthetic database");
  noteAuthProfileFileWrite(fs.realpathSync(databasePath));

  const current = captureAuthProfileFileIdentity(aliasPath);
  expect(current.identity?.key).toMatch(/^file:/);
  expect(current.identity?.canonicalPath).toBe(before?.canonicalPath);
  expect(() => current.assertCurrent()).not.toThrow();
});

it("keeps first-write authority when publication overtakes an observed file read", async () => {
  const directory = temporary.make("auth-file-publication-race-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  readAuthProfileDatabaseIdentity(databasePath);
  const original = fs.promises.stat;
  let published: ReturnType<typeof captureAuthProfileFileIdentity> | undefined;
  const stat = vi.spyOn(fs.promises, "stat").mockImplementationOnce((...args) => {
    fs.writeFileSync(databasePath, "created synthetic database");
    noteAuthProfileFileWrite(databasePath);
    published = captureAuthProfileFileIdentity(databasePath);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await refreshAuthProfileFileState();
    expect(published?.identity?.key).toMatch(/^file:/);
    expect(() => published!.assertCurrent()).not.toThrow();
  } finally {
    stat.mockRestore();
    syncBuiltinESMExports();
  }
});

it("explicitly refreshes absent files without retiring unchanged authority", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(fs, "watch").mockImplementation(() => {
    throw new Error("synthetic unavailable watcher");
  });
  const directory = temporary.make("auth-file-explicit-refresh-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  const legacyPath = path.join(directory, "auth.json");
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).toMatch(/^path:/);
  expect(authProfileSourceExists(legacyPath)).toBe(false);

  fs.writeFileSync(databasePath, "created synthetic database");
  fs.writeFileSync(legacyPath, "{}");
  await refreshAuthProfileFileState();

  const captured = captureAuthProfileFileIdentity(databasePath);
  expect(captured.identity?.key).toMatch(/^file:/);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
  await Promise.all([refreshAuthProfileFileState(), refreshAuthProfileFileState()]);
  expect(() => captured.assertCurrent()).not.toThrow();
});

it("joins a fallback observation received while a prior refresh is pending", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(fs, "watch").mockImplementation(() => {
    throw new Error("synthetic unavailable watcher");
  });
  const directory = temporary.make("auth-file-coalesced-refresh-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  fs.writeFileSync(databasePath, "synthetic database");
  readAuthProfileDatabaseIdentity(databasePath);
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let passes = 0;
  const unsubscribe = registerAuthProfileFileChangeListener(async (change) => {
    if (change.directory !== directory) {
      return;
    }
    passes += 1;
    if (passes === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else if (passes === 2) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
  });
  let completed = false;
  const pending = refreshAuthProfileFileState().then(() => {
    completed = true;
  });
  try {
    await firstStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(passes).toBe(1);
    releaseFirst.resolve();

    expect(
      await Promise.race([
        secondStarted.promise.then(() => "second pass"),
        pending.then(() => "completed"),
      ]),
    ).toBe("second pass");
    expect(completed).toBe(false);
    releaseSecond.resolve();
    await pending;
    expect(passes).toBe(2);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await pending;
    unsubscribe();
  }
});

it("invalidates admitted auth facts after a separate process replaces their files", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const directory = temporary.make("auth-file-owner-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  const legacyPath = path.join(directory, "auth-profiles.json");
  fs.writeFileSync(databasePath, "initial synthetic database");
  const captured = captureAuthProfileFileIdentity(databasePath);
  const before = captured.identity;
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  const changed = new Promise<void>((resolve) => {
    const unsubscribe = registerAuthProfileFileChangeListener(({ directory: changedDirectory }) => {
      if (directory === changedDirectory) {
        unsubscribe();
        resolve();
      }
    });
  });
  await promisify(execFile)(process.execPath, [
    "-e",
    'const fs = require("node:fs"); const [db, legacy] = process.argv.slice(1); fs.writeFileSync(db + ".replacement", "replacement synthetic database"); fs.renameSync(db + ".replacement", db); fs.writeFileSync(legacy, "{}");',
    databasePath,
    legacyPath,
  ]);
  await vi.advanceTimersByTimeAsync(30_000);
  await changed;
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).not.toBe(before?.key);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
  const stat = vi.spyOn(fs, "statSync");
  const exists = vi.spyOn(fs, "existsSync");
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).not.toBe(before?.key);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
  expect(stat).not.toHaveBeenCalled();
  expect(exists).not.toHaveBeenCalled();
});

it("periodically invalidates when directory events are unavailable", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(fs, "watch").mockImplementation(() => {
    throw new Error("synthetic unavailable watcher");
  });
  const directory = temporary.make("auth-file-fallback-");
  const legacyPath = path.join(directory, "auth.json");
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  const changed = new Promise<void>((resolve) => {
    const unsubscribe = registerAuthProfileFileChangeListener(({ directory: observed }) => {
      if (observed === directory) {
        unsubscribe();
        resolve();
      }
    });
  });
  fs.writeFileSync(legacyPath, "{}");
  await vi.advanceTimersByTimeAsync(30_000);
  await changed;
  expect(authProfileSourceExists(legacyPath)).toBe(true);
});

it("keeps an absent database readable as missing after fallback revalidation", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const directory = temporary.make("auth-file-still-missing-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  const captured = captureAuthProfileFileIdentity(databasePath);
  const changed = new Promise<void>((resolve) => {
    const unsubscribe = registerAuthProfileFileChangeListener(({ directory: observed }) => {
      if (observed === directory) {
        unsubscribe();
        resolve();
      }
    });
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await changed;
  expect(readAuthProfileDatabaseIdentity(databasePath)).toEqual(captured.identity);
  expect(() => captured.assertCurrent()).not.toThrow();
});

it("retires observations with the database owner", async () => {
  const directory = temporary.make("auth-file-retired-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  fs.writeFileSync(databasePath, "synthetic database");
  const captured = captureAuthProfileFileIdentity(databasePath);
  await applyAgentDatabaseReaderRequest({
    kind: "close",
    candidates: [{ path: databasePath }],
    deleted: false,
  });
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
  expect(() => captureAuthProfileFileIdentity(databasePath).assertCurrent()).not.toThrow();
});

it("keeps physical file authority through logical snapshot reset", async () => {
  const directory = temporary.make("auth-file-logical-reset-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  fs.writeFileSync(databasePath, "synthetic database");
  const captured = captureAuthProfileFileIdentity(databasePath);
  clearRuntimeAuthProfileStoreSnapshots();
  expect(() => captured.assertCurrent()).not.toThrow();
  await closeOpenClawStateDatabaseAsync();
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
});

it("keeps sibling file authority when another database is replaced or retired", async () => {
  const directory = temporary.make("auth-file-siblings-");
  const first = path.join(directory, "first.sqlite");
  const second = path.join(directory, "second.sqlite");
  fs.writeFileSync(first, "first synthetic database");
  fs.writeFileSync(second, "second synthetic database");
  const retained = captureAuthProfileFileIdentity(first);
  const replaced = captureAuthProfileFileIdentity(second);
  fs.writeFileSync(`${second}.replacement`, "replacement synthetic database");
  fs.renameSync(`${second}.replacement`, second);
  await refreshAuthProfileFileState();
  expect(() => retained.assertCurrent()).not.toThrow();
  expect(() => replaced.assertCurrent()).toThrow("database file identity changed");
  const retired = captureAuthProfileFileIdentity(second);
  await applyAgentDatabaseReaderRequest({
    kind: "close",
    candidates: [{ path: first }, { path: second }],
    retainedPaths: [first],
    deleted: false,
  });
  expect(() => retained.assertCurrent()).not.toThrow();
  expect(() => retired.assertCurrent()).toThrow("database file identity changed");
});

it("reports a first database file separately from a replaced credential source", async () => {
  const directory = temporary.make("auth-file-first-session-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  readAuthProfileDatabaseIdentity(databasePath);
  const changes: Array<{ identityChanged: boolean; createdPaths: readonly string[] }> = [];
  const unsubscribe = registerAuthProfileFileChangeListener((change) => {
    if (change.directory === directory) {
      changes.push(change);
    }
  });
  try {
    fs.writeFileSync(databasePath, "first synthetic database");
    await refreshAuthProfileFileState();
    expect(changes).toContainEqual(
      expect.objectContaining({
        identityChanged: false,
        createdPaths: [databasePath],
      }),
    );
  } finally {
    unsubscribe();
  }
});

it("retires legacy source observations when their agent database closes", async () => {
  const directory = temporary.make("auth-file-presence-retirement-");
  const legacyPath = path.join(directory, "auth.json");
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  await applyAgentDatabaseReaderRequest({
    kind: "close",
    candidates: [{ path: path.join(directory, "openclaw-agent.sqlite") }],
    deleted: false,
  });
  fs.writeFileSync(legacyPath, "{}");
  expect(authProfileSourceExists(legacyPath)).toBe(true);
});
