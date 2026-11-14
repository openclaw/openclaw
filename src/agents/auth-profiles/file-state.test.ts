import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import * as directoryWatch from "../../infra/directory-watch-host.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import {
  authProfileSourceExists,
  captureAuthProfileFileIdentity,
  readAuthProfileDatabaseIdentity,
  noteAuthProfileFileWrite,
  refreshAuthProfileFileState,
  authProfileFileChanges,
} from "./file-state.js";
import { runtimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const publishFileChange = authProfileFileChanges.onChange;
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

afterEach(async () => {
  authProfileFileChanges.onChange = publishFileChange;
  runtimeAuthProfileRowsCache.clear();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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
        spawned++;
        throw new Error("Worker auth observation requested a row child");
      };
      fs.watch = () => { throw new Error("synthetic unavailable watcher"); };
      // macOS admits hosted watchers by opening their directory before spawning.
      const watchDirectories = new Set();
      for (let current = workerData.directory; ; current = path.dirname(current)) {
        watchDirectories.add(current);
        if (path.dirname(current) === current) break;
      }
      const openSync = fs.openSync;
      fs.openSync = (file, ...args) => {
        if (process.platform === "darwin" && watchDirectories.has(file)) {
          throw new Error("synthetic unavailable watcher");
        }
        return openSync(file, ...args);
      };
      syncBuiltinESMExports();
      (async () => {
        const { register } = await import(workerData.loader);
        const unregister = register();
        const load = (relative) => import(new URL(relative, workerData.base).href);
        const files = await load("./file-state.ts");
        const snapshots = await load("./runtime-snapshots.ts");
        const { runtimeAuthProfileRowsCache } = await load("./runtime-persisted-rows.ts");
        const { acquireAuthProfileReadDatabase } = await load("./sqlite-read-pool.ts");
        const { readAuthProfileRowsReadOnly } = await load("./sqlite-json.ts");
        const { openSqliteReadOnlyDatabase } = await load("../../infra/sqlite-snapshot-source.ts");
        const { runInDetachedAsyncContext } = await load("../../shared/detached-async-context.ts");
        const { closeOpenClawStateDatabaseAsync } = await load("../../state/openclaw-state-db-cache.ts");
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
          const { db: reader } = acquireAuthProfileReadDatabase(databasePath, openSqliteReadOnlyDatabase);
          const owner = { databasePath, sharedDatabasePath: databasePath, location: "legacy-main" };
          snapshots.setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
            store("worker-original"), databasePath, workerData.directory, owner
          );
          snapshots.recordRuntimeAuthProfilePersistedStore(databasePath, store("worker-original"));
          writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{"fixture":"fixture"}}');
          assert.ok(fs.statSync(databasePath + "-wal").size > 0);
          await runInDetachedAsyncContext(files.refreshAuthProfileFileState);
          assert.equal(spawned, 0, "WAL-only observation must not launch an auth row child");
          assert.deepEqual([runtimeAuthProfileRowsCache.hasSource(databasePath), reader.isOpen], [false, true]);
          assert.deepEqual(snapshots.getRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath), store("worker-original"));

          writer.close();
          const replacement = databasePath + ".replacement";
          create(replacement, "worker-replacement").close();
          fs.renameSync(replacement, databasePath);
          await runInDetachedAsyncContext(files.refreshAuthProfileFileState);
          assert.deepEqual([reader.isOpen, snapshots.getRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath), spawned], [false, undefined, 0]);
          assert.deepEqual(readAuthProfileRowsReadOnly(databasePath, openSqliteReadOnlyDatabase).store, {
            status: "readable", raw: store("worker-replacement")
          });
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
          base: import.meta.url,
        },
      },
    );
    try {
      const [[result], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
      expect([code, result]).toEqual([0, "worker observations verified"]);
    } finally {
      await worker.terminate();
    }
  },
);

function fixture(options: { timers?: boolean; fallback?: boolean; existing?: boolean } = {}) {
  if (options.timers) {
    useObservationTimers();
  }
  if (options.fallback) {
    disableWatcher();
  }
  const directory = temporary.make("auth-file-");
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  if (options.existing) {
    fs.writeFileSync(databasePath, "synthetic database");
  }
  return { directory, databasePath, legacyPath: path.join(directory, "auth.json") };
}
function useObservationTimers() {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}
function disableWatcher() {
  vi.spyOn(fs, "watch").mockImplementation(() => {
    throw new Error("synthetic unavailable watcher");
  });
}
function nextChange(directory: string) {
  return new Promise<void>((resolve) => {
    listen(directory, () => {
      authProfileFileChanges.onChange = publishFileChange;
      resolve();
    });
  });
}

function listen(directory: string, listener: NonNullable<typeof authProfileFileChanges.onChange>) {
  authProfileFileChanges.onChange = async (change) => {
    await publishFileChange?.(change);
    if (change.directory === directory) {
      return listener(change);
    }
  };
}

function replaceFile(databasePath: string) {
  fs.writeFileSync(`${databasePath}.replacement`, "replacement synthetic database");
  fs.renameSync(`${databasePath}.replacement`, databasePath);
}

async function observe(change: Promise<void>) {
  await vi.advanceTimersByTimeAsync(30_000);
  await change;
}

function closeFiles(paths: string[], retainedPaths?: string[]) {
  return applyAgentDatabaseReaderRequest({
    kind: "close",
    candidates: paths.map((pathname) => ({ path: pathname })),
    retainedPaths,
    deleted: false,
  });
}

it("ignores content and sidecar events but observes replacement and nameless invalidation", async () => {
  const { databasePath } = fixture({ existing: true });
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const watch = vi.spyOn(directoryWatch, "watchDirectory").mockReturnValue(watcher);
  const captured = captureAuthProfileFileIdentity(databasePath);
  const changed = watch.mock.calls[0]![1];
  const stat = vi.spyOn(fs.promises, "stat");
  syncBuiltinESMExports();
  for (let index = 0; index < 100; index++) {
    changed("change", path.basename(databasePath));
    changed("rename", `${path.basename(databasePath)}-wal`);
  }
  await Promise.resolve();
  expect(stat).not.toHaveBeenCalled();
  replaceFile(databasePath);
  const replaced = nextChange(path.dirname(databasePath));
  changed("rename", path.basename(databasePath));
  await replaced;
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
  const replacement = captureAuthProfileFileIdentity(databasePath);
  fs.unlinkSync(databasePath);
  const deleted = nextChange(path.dirname(databasePath));
  changed("change");
  await deleted;
  expect(() => replacement.assertCurrent()).toThrow("database file identity changed");
});

it("publishes a first owner write immediately and keeps same-file writes from revoking identity", async () => {
  const { directory, databasePath } = fixture({ timers: true });
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).toMatch(/^path:/);
  fs.writeFileSync(databasePath, "created synthetic database");
  noteAuthProfileFileWrite(databasePath);
  const captured = captureAuthProfileFileIdentity(databasePath);
  expect(captured.identity?.key).toMatch(/^file:/);
  const changed = nextChange(directory);
  fs.writeFileSync(databasePath, "session-only write in the same file");
  await observe(changed);
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
  const { databasePath } = fixture();
  readAuthProfileDatabaseIdentity(databasePath);
  const original = fs.promises.stat;
  let published: ReturnType<typeof captureAuthProfileFileIdentity> | undefined;
  vi.spyOn(fs.promises, "stat").mockImplementationOnce((...args) => {
    fs.writeFileSync(databasePath, "created synthetic database");
    noteAuthProfileFileWrite(databasePath);
    published = captureAuthProfileFileIdentity(databasePath);
    return original(...args);
  });
  syncBuiltinESMExports();
  await refreshAuthProfileFileState();
  expect(published?.identity?.key).toMatch(/^file:/);
  expect(() => published!.assertCurrent()).not.toThrow();
});

it("reports first-file creation on explicit refresh without retiring unchanged authority", async () => {
  const { directory, databasePath, legacyPath } = fixture({ timers: true, fallback: true });
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).toMatch(/^path:/);
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  const changes: Array<{ identityChanged: boolean; createdPaths: readonly string[] }> = [];
  listen(directory, (change) => {
    changes.push(change);
  });

  fs.writeFileSync(databasePath, "created synthetic database");
  fs.writeFileSync(legacyPath, "{}");
  await refreshAuthProfileFileState();
  expect(changes).toContainEqual(
    expect.objectContaining({ identityChanged: false, createdPaths: [databasePath] }),
  );

  const captured = captureAuthProfileFileIdentity(databasePath);
  expect(captured.identity?.key).toMatch(/^file:/);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
  await Promise.all([refreshAuthProfileFileState(), refreshAuthProfileFileState()]);
  expect(() => captured.assertCurrent()).not.toThrow();
});

it("joins a fallback observation received while a prior refresh is pending", async () => {
  const { directory, databasePath } = fixture({ timers: true, fallback: true, existing: true });
  readAuthProfileDatabaseIdentity(databasePath);
  const gate = () => ({
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  });
  const gates = [gate(), gate()] as const;
  let passes = 0;
  listen(directory, async () => {
    const current = gates[passes++];
    if (current) {
      current.started.resolve();
      await current.release.promise;
    }
  });
  let completed = false;
  const pending = refreshAuthProfileFileState().then(() => {
    completed = true;
  });
  try {
    await gates[0].started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(passes).toBe(1);
    gates[0].release.resolve();

    expect(
      await Promise.race([
        gates[1].started.promise.then(() => "second pass"),
        pending.then(() => "completed"),
      ]),
    ).toBe("second pass");
    expect(completed).toBe(false);
    gates[1].release.resolve();
    await pending;
    expect(passes).toBe(2);
  } finally {
    gates.forEach(({ release }) => release.resolve());
    await pending;
  }
});

it("invalidates admitted auth facts after a separate process replaces their files", async () => {
  const { directory, databasePath } = fixture({ timers: true, existing: true });
  const legacyPath = path.join(directory, "auth-profiles.json");
  const captured = captureAuthProfileFileIdentity(databasePath);
  const before = captured.identity;
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  const changed = Promise.withResolvers<void>();
  listen(directory, (change) => {
    if (change.identityChanged) {
      changed.resolve();
    }
  });
  await promisify(execFile)(process.execPath, [
    "-e",
    'const fs = require("node:fs"); const [db, legacy] = process.argv.slice(1); fs.writeFileSync(db + ".replacement", "replacement synthetic database"); fs.renameSync(db + ".replacement", db); fs.writeFileSync(legacy, "{}");',
    databasePath,
    legacyPath,
  ]);
  await observe(changed.promise);
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
  const stat = vi.spyOn(fs, "statSync");
  const exists = vi.spyOn(fs, "existsSync");
  expect(readAuthProfileDatabaseIdentity(databasePath)?.key).not.toBe(before?.key);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
  expect(stat).not.toHaveBeenCalled();
  expect(exists).not.toHaveBeenCalled();
});

it("periodically invalidates when directory events are unavailable", async () => {
  const { directory, legacyPath } = fixture({ timers: true, fallback: true });
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  const changed = nextChange(directory);
  fs.writeFileSync(legacyPath, "{}");
  await observe(changed);
  expect(authProfileSourceExists(legacyPath)).toBe(true);
});

it("keeps an absent database readable as missing after fallback revalidation", async () => {
  const { directory, databasePath } = fixture({ timers: true });
  const captured = captureAuthProfileFileIdentity(databasePath);
  const changed = nextChange(directory);
  await observe(changed);
  expect(readAuthProfileDatabaseIdentity(databasePath)).toEqual(captured.identity);
  expect(() => captured.assertCurrent()).not.toThrow();
});

it("retires observations with the database owner", async () => {
  const { databasePath } = fixture({ existing: true });
  const captured = captureAuthProfileFileIdentity(databasePath);
  await closeFiles([databasePath]);
  expect(() => captured.assertCurrent()).toThrow("database file identity changed");
  expect(() => captureAuthProfileFileIdentity(databasePath).assertCurrent()).not.toThrow();
});

it("keeps physical file authority through logical snapshot reset", async () => {
  const { databasePath } = fixture({ existing: true });
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
  replaceFile(second);
  await refreshAuthProfileFileState();
  expect(() => retained.assertCurrent()).not.toThrow();
  expect(() => replaced.assertCurrent()).toThrow("database file identity changed");
  const retired = captureAuthProfileFileIdentity(second);
  await closeFiles([first, second], [first]);
  expect(() => retained.assertCurrent()).not.toThrow();
  expect(() => retired.assertCurrent()).toThrow("database file identity changed");
});

it("retires legacy source observations when their agent database closes", async () => {
  const { databasePath, legacyPath } = fixture();
  expect(authProfileSourceExists(legacyPath)).toBe(false);
  await closeFiles([databasePath]);
  fs.writeFileSync(legacyPath, "{}");
  expect(authProfileSourceExists(legacyPath)).toBe(true);
});
