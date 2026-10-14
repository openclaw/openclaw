import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { AdmissionOperations } from "../../infra/sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import { readAuthProfileRows } from "./sqlite-json.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function emptyRows(): AuthProfileRowRead {
  return {
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "readable", raw: { lastGood: {} } },
    cacheable: true,
  };
}

it("preserves absent source provenance through first database admission", () => {
  const databasePath = path.join(tempDirs.make("auth-row-first-admission-"), "auth.sqlite");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  cache.recordSource(databasePath, "absent", null);
  expect(cache.hasSource(databasePath)).toBe(true);

  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE session_fixture (value INTEGER)");
  expect(cache.hasSource(databasePath)).toBe(true);

  cache.recordSource(databasePath, "created", null);
  database.exec("INSERT INTO session_fixture VALUES (1)");
  expect(cache.hasSource(databasePath)).toBe(false);
});

it("releases retired database baselines while retaining named live owners", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-retirement-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => emptyRows());
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }).read();
  await resolve();
  cache.retire([{ path: databasePath }], new Set([databasePath]));
  await resolve();
  expect(read).toHaveBeenCalledOnce();
  cache.retire([{ path: databasePath }]);
  await resolve();
  expect(read).toHaveBeenCalledTimes(2);
  cache.publishSnapshots(new Set());
  await resolve();
  expect(read).toHaveBeenCalledTimes(3);
});

it.each([true, false])(
  "shares immutable persisted rows regardless of worker cacheability: %s",
  async (cacheable) => {
    const databasePath = path.join(tempDirs.make("auth-row-cache-"), "auth.sqlite");
    using database = openNodeSqliteDatabase(databasePath);
    database.exec("CREATE TABLE cache_fixture (value)");
    const rows = {
      store: {
        status: "readable" as const,
        raw: {
          version: 1,
          profiles: {
            "example:key": {
              type: "api_key",
              provider: "example",
              keyRef: { source: "env", provider: "default", id: "EXAMPLE_KEY" },
            },
          },
        },
      },
      state: { status: "readable" as const, raw: { order: { example: ["example:key"] } } },
      cacheable,
    };
    const read = vi.fn(async () => rows);
    const cache = createRuntimeAuthProfileRowsCache(() => "1");
    const resolve = () => cache.prepare(databasePath, { read, assertCurrent: () => {} }).read();
    const first = await resolve();
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    // Reject changes at every retained level, including credential refs and order arrays.
    function assertImmutable(value: unknown) {
      if (value === null || typeof value !== "object") {
        return;
      }
      expect(Reflect.set(value, "injected", true)).toBe(false);
      for (const [key, child] of Object.entries(value)) {
        expect(Reflect.set(value, key, null)).toBe(false);
        assertImmutable(child);
      }
    }
    assertImmutable(first);
    expect(await resolve()).toEqual(rows);
  },
);

it("serves a committed postimage without rereading or freezing its publisher", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-postimage-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => emptyRows());
  const resolve = () =>
    cache.prepare(databasePath, { identity: "fixture", read, assertCurrent() {} }).read();
  await resolve();
  const committed: AuthProfileStore = {
    version: 1,
    profiles: { "example:key": { type: "api_key", provider: "example", key: "fixture-new" } },
    lastGood: { example: "example:key" },
  };
  cache.recordSource(databasePath, "fixture", committed);
  committed.profiles = {};
  committed.lastGood!.example = "caller-edit";
  const rows = await resolve();
  expect(rows.store).toMatchObject({
    status: "readable",
    raw: {
      profiles: {
        "example:key": { key: "fixture-new" },
      },
    },
  });
  expect(rows.state).toMatchObject({
    status: "readable",
    raw: { lastGood: { example: "example:key" } },
  });
  expect(read).toHaveBeenCalledOnce();
  cache.recordSource(databasePath, "fixture", null);
  await resolve();
  expect(read).toHaveBeenCalledTimes(2);
});

it("retains rows across session writes and invalidates them on auth writer-worker receipts", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-receipts-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    CREATE TABLE session_fixture (value INTEGER);
    INSERT INTO session_fixture VALUES (0);
    INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
    INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  const broker = new SqliteWorkerBroker();
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => readAuthProfileRows(database, databasePath, "agent"));
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }).read();
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl: new URL(
        "../../infra/sqlite-database-admission.worker.test-support.ts",
        import.meta.url,
      ),
      databasePath,
      input: undefined,
    });
    const first = await resolve();
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      observation.queries.filter((sql) => /auth_profile_(store|state)/u.test(sql)),
    ).toHaveLength(1);
    await store!.execute({
      type: "writeRows",
      input: {
        sql: "UPDATE session_fixture SET value=value+1",
        sessionKeys: ["agent:fixture"],
      },
    });
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    const write = () =>
      store!.execute({
        type: "writeRows",
        input: {
          sql: `UPDATE auth_profile_state SET state_json='{"lastGood":{"example":"example:key"}}'`,
        },
      });
    await write();
    expect((await resolve()).state).toEqual({
      status: "readable",
      raw: { lastGood: { example: "example:key" } },
    });
    expect(read).toHaveBeenCalledTimes(2);
    cache.clear();
    read.mockImplementationOnce(async () => {
      const rows = readAuthProfileRows(database, databasePath, "agent");
      await write();
      return rows;
    });
    await resolve();
    await resolve();
    expect(read).toHaveBeenCalledTimes(4);
    expect(
      observation.queries.filter((sql) => /data_version|wal_checkpoint|page_size/iu.test(sql)),
    ).toEqual([]);
  } finally {
    observation.restore();
    await broker.close();
  }
});

it("reads shared credentials and health together after an in-process write", () => {
  const databasePath = path.join(tempDirs.make("shared-auth-rows-"), "state.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO config_machine_state VALUES ('authProfiles.store', '{"version":1,"profiles":{}}');
    INSERT INTO config_machine_state VALUES ('authProfiles.state', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  readAuthProfileRows(database, databasePath, "shared-state");
  database.exec(`
    UPDATE config_machine_state SET value_json='{"lastGood":{"example":"example:key"}}'
    WHERE state_key='authProfiles.state';
  `);
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    expect(readAuthProfileRows(database, databasePath, "shared-state")).toMatchObject({
      store: { status: "readable", raw: { version: 1, profiles: {} } },
      state: { status: "readable", raw: { lastGood: { example: "example:key" } } },
    });
    expect(observation.queries).toHaveLength(1);
  } finally {
    observation.restore();
  }
});

it("keeps an independently absent credential row when the legacy health table is malformed", () => {
  const databasePath = path.join(tempDirs.make("legacy-auth-rows-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY);
  `);
  admitSqliteSchema(database);
  expect(readAuthProfileRows(database, databasePath, "agent")).toEqual({
    store: { status: "missing", reason: "row" },
    state: { status: "unreadable" },
    cacheable: false,
  });
});
