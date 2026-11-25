import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openSqliteReadOnlyDatabase as openReader } from "../../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync as pathIdentity } from "../../infra/sqlite-worker-identity.js";
import { readAuthProfileRowsReadOnly as readRows } from "./sqlite-json.js";
import {
  acquireAuthProfileReadDatabase as acquireReader,
  closeAuthProfileReadPool,
} from "./sqlite-read-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readable = (raw: object) => ({ status: "readable", raw });
const credentials = (key: string) => ({ profiles: { fixture: { key } } });

function withDatabase(databasePath: string, store: object, run = (_writer: DatabaseSync) => {}) {
  const writer = openNodeSqliteDatabase(databasePath);
  try {
    writer.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    `);
    writer
      .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?)")
      .run(JSON.stringify(store));
    run(writer);
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
    writer.close();
  }
}

const readerArgs = (file: string) => [file, openReader, undefined, pathIdentity(file).key] as const;
const read = (file: string) => readRows(...readerArgs(file));

it("keeps the auth reader alive across committed writes until owner disposal", () => {
  const databasePath = path.join(tempDirs.make("auth-reader-lifetime-"), "agent.sqlite");
  withDatabase(databasePath, { version: 1, profiles: {} }, (writer) => {
    writer.exec(`INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}')`);
    const acquired = acquireReader(...readerArgs(databasePath));
    assert(acquired.status === "readable", "Auth reader unavailable");
    const reader = acquired.db;
    expect(read(databasePath)).toMatchObject({
      store: readable({ version: 1, profiles: {} }),
      state: readable({ lastGood: {} }),
    });
    expect(reader.isOpen).toBe(true);

    writer.exec(`UPDATE auth_profile_state SET state_json = '{"lastGood":{"fixture":"new"}}'`);
    const committed = readable({ lastGood: { fixture: "new" } });
    expect(read(databasePath).state).toEqual(committed);
    expect(acquireReader(databasePath, openReader)).toEqual({ status: "readable", db: reader });

    closeAuthProfileReadPool({ kind: "database", databasePath });
    expect(reader.isOpen).toBe(false);
    expect(read(databasePath).state).toEqual(committed);
  });
});
it.skipIf(process.platform === "win32")("does not reuse credentials from a replaced file", () => {
  const databasePath = path.join(tempDirs.make("auth-reader-replacement-"), "agent.sqlite");
  try {
    withDatabase(databasePath, credentials("old-synthetic-key"));
    expect(read(databasePath).store).toMatchObject({ raw: credentials("old-synthetic-key") });
    withDatabase(`${databasePath}.replacement`, credentials("new-synthetic-key"));
    fs.renameSync(databasePath, `${databasePath}.old`);
    fs.renameSync(`${databasePath}.replacement`, databasePath);
    expect(read(databasePath).store).toMatchObject({ raw: credentials("new-synthetic-key") });
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
});
