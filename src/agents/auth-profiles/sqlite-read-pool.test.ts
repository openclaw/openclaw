import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { readAuthProfileRowsReadOnly } from "./sqlite-json.js";
import { acquireAuthProfileReadDatabase, closeAuthProfileReadPool } from "./sqlite-read-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function read(databasePath: string) {
  return readAuthProfileRowsReadOnly(
    databasePath,
    undefined,
    readDatabasePathIdentitySync(databasePath).key,
  );
}

it("keeps the auth reader alive across committed writes until owner disposal", () => {
  const databasePath = path.join(tempDirs.make("auth-reader-lifetime-"), "agent.sqlite");
  const writer = openNodeSqliteDatabase(databasePath);
  try {
    writer.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
      INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
      INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}');
    `);
    const acquired = acquireAuthProfileReadDatabase(
      databasePath,
      undefined,
      readDatabasePathIdentitySync(databasePath).key,
    );
    expect(acquired.status).toBe("readable");
    if (acquired.status !== "readable") {
      throw new Error("Auth reader unavailable");
    }
    const reader = acquired.db;
    expect(read(databasePath)).toMatchObject({
      store: { status: "readable", raw: { version: 1, profiles: {} } },
      state: { status: "readable", raw: { lastGood: {} } },
    });
    expect(reader.isOpen).toBe(true);

    writer
      .prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = 'primary'")
      .run('{"lastGood":{"fixture":"fixture:default"}}');
    expect(read(databasePath).state).toEqual({
      status: "readable",
      raw: { lastGood: { fixture: "fixture:default" } },
    });
    expect(acquireAuthProfileReadDatabase(databasePath)).toEqual({
      status: "readable",
      db: reader,
    });

    closeAuthProfileReadPool({ kind: "database", databasePath });
    expect(reader.isOpen).toBe(false);
    expect(read(databasePath).state).toEqual({
      status: "readable",
      raw: { lastGood: { fixture: "fixture:default" } },
    });
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
    writer.close();
  }
});
it.skipIf(process.platform === "win32")("does not reuse credentials from a replaced file", () => {
  const databasePath = path.join(tempDirs.make("auth-reader-replacement-"), "agent.sqlite");
  const create = (pathname: string, key: string) => {
    const writer = openNodeSqliteDatabase(pathname);
    try {
      writer.exec(`
        CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
        CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
      `);
      writer
        .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?)")
        .run(JSON.stringify({ profiles: { fixture: { key } } }));
    } finally {
      writer.close();
    }
  };
  try {
    create(databasePath, "old-synthetic-key");
    expect(read(databasePath).store).toMatchObject({
      raw: { profiles: { fixture: { key: "old-synthetic-key" } } },
    });
    create(`${databasePath}.replacement`, "new-synthetic-key");
    fs.renameSync(databasePath, `${databasePath}.old`);
    fs.renameSync(`${databasePath}.replacement`, databasePath);
    expect(read(databasePath).store).toMatchObject({
      raw: { profiles: { fixture: { key: "new-synthetic-key" } } },
    });
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
});
