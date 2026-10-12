import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../../infra/node-sqlite.js";
import {
  readMainDatabasePosixLocks,
  readSqliteShmPosixLocks,
} from "../../../infra/sqlite-posix-locks.test-support.js";
import { runSqliteReadOnlyWorker } from "../../../infra/sqlite-readonly-worker.js";
import { createReadTool } from "./read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "keeps a live WAL mapping locked while reading its files and opening a read-only worker",
  async () => {
    const directory = tempDirs.make("read-sqlite-locks-");
    const pathname = path.join(directory, "agent.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(pathname);
    try {
      writer.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE auth_profile_store(store_key TEXT PRIMARY KEY, store_json TEXT);
        CREATE TABLE auth_profile_state(state_key TEXT PRIMARY KEY, state_json TEXT);
        BEGIN;
        SELECT * FROM auth_profile_store;
      `);
      const before = fs.statSync(`${pathname}-shm`);
      const identity = fs.statSync(pathname);
      const mainLocks = readMainDatabasePosixLocks(pathname);
      const shmLocks = readSqliteShmPosixLocks(`${pathname}-shm`);
      expect(before.size).toBe(32768);
      expect(mainLocks).toEqual([
        { length: 510, pid: process.pid, start: 1073741826, type: "read" },
      ]);
      expect(shmLocks).toEqual([{ length: 1, pid: process.pid, start: 128, type: "read" }]);
      const read = createReadTool(directory, { modelHasVision: false });
      for (const suffix of ["", "-wal", "-shm"]) {
        await read.execute("read-live-file", { path: pathname + suffix });
      }
      const alias = path.join(directory, "notes.txt");
      fs.linkSync(`${pathname}-shm`, alias);
      await read.execute("read-live-alias", { path: alias });
      // Fail before opening another SQLite connection: a lost DMS lock can SIGBUS this process.
      expect(readSqliteShmPosixLocks(`${pathname}-shm`)).toEqual(shmLocks);
      expect(readMainDatabasePosixLocks(pathname)).toEqual(mainLocks);
      await runSqliteReadOnlyWorker(pathname, {
        mode: "auth-profile-rows",
        source: "canonical",
        expectedIdentity: `file:${identity.dev}:${identity.ino}`,
        env: process.env,
      });
      expect(fs.statSync(`${pathname}-shm`)).toMatchObject({ size: before.size, ino: before.ino });
      expect(readSqliteShmPosixLocks(`${pathname}-shm`)).toEqual(shmLocks);
      expect(writer.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      writer.close();
    }
  },
);
