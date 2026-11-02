import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openTrackedStateDatabase } from "../../state/openclaw-state-db-handle.js";
import { createApiKeyCredential as apiKey } from "./credential-fixtures.test-support.js";
import { recordRuntimeAuthProfileStorePersistedMutation } from "./mutation-lineage.js";
import { runtimeAuthProfileRowsCache as cache } from "./runtime-persisted-rows.js";
import { deleteAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { readAuthProfileRows } from "./sqlite-json.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => cache.clear());
afterEach(() => cache.clear());

function noteCredentialMutation(databasePath: string) {
  recordRuntimeAuthProfileStorePersistedMutation(databasePath, {
    credentialsChanged: true,
    stateChanged: false,
    profileIds: ["example:key"],
  });
}
const profileStore = (key = "fixture"): AuthProfileStore => ({
  version: 1,
  profiles: { "example:key": apiKey("example", key) },
});

function emptyRows(): AuthProfileRowRead {
  return {
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "readable", raw: { lastGood: {} } },
    cacheable: true,
  };
}

it("preserves absent source provenance through first database admission", () => {
  const databasePath = path.join(tempDirs.make("auth-row-first-admission-"), "auth.sqlite");
  cache.recordSource(databasePath, "absent", null);
  expect(cache.hasSource(databasePath)).toBe(true);

  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE session_fixture (value INTEGER)");
  expect(cache.hasSource(databasePath)).toBe(true);

  cache.recordSource(databasePath, "created", null);
  database.exec("INSERT INTO session_fixture VALUES (1)");
  expect(cache.hasSource(databasePath)).toBe(true);
});

it("releases retired database baselines while retaining named live owners", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-retirement-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
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
  const read = vi.fn(async () => emptyRows());
  const resolve = () =>
    cache.prepare(databasePath, { identity: "fixture", read, assertCurrent() {} }).read();
  await resolve();
  const committed = { ...profileStore("fixture-new"), lastGood: { example: "example:key" } };
  noteCredentialMutation(databasePath);
  cache.recordSource(databasePath, "fixture", committed);
  committed.profiles = {};
  committed.lastGood!.example = "caller-edit";
  const rows = await resolve();
  expect(rows).toMatchObject({
    store: { status: "readable", raw: { profiles: { "example:key": { key: "fixture-new" } } } },
    state: { status: "readable", raw: { lastGood: { example: "example:key" } } },
  });
  expect(read).toHaveBeenCalledOnce();
  cache.recordSource(databasePath, "fixture", null);
  await resolve();
  expect(read).toHaveBeenCalledTimes(2);
});

it("retains private lifetimes across runtime publication and reloads incomplete postimages", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-lifetimes-"), "auth.sqlite");
  const store = profileStore();
  const rows = {
    ...emptyRows(),
    store: {
      status: "readable" as const,
      raw: {
        ...store,
        authorizationLifetimes: { "example:key": "00000000-0000-4000-8000-000000000001" },
      },
    },
  };
  const read = vi.fn(async () => rows);
  const resolve = (source: "runtime" | "canonical") =>
    cache.prepare(databasePath, { identity: "fixture", read, assertCurrent() {} }, source).read();
  await resolve("runtime");
  cache.recordSource(databasePath, "fixture", store);
  expect(await resolve("canonical")).toEqual(rows);
  expect(read).toHaveBeenCalledOnce();

  noteCredentialMutation(databasePath);
  cache.recordSource(databasePath, "fixture", store);
  expect((await resolve("runtime")).store).toEqual({ status: "readable", raw: store });
  expect(await resolve("canonical")).toEqual(rows);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["agent", "shared-state"] as const)(
  "retains %s rows across unrelated writes and follows committed auth writes",
  async (kind) => {
    const databasePath = path.join(tempDirs.make("auth-row-receipts-"), "auth.sqlite");
    using database = openTrackedStateDatabase(databasePath);
    database.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT, updated_at INTEGER);
      CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
      CREATE TABLE session_fixture (value INTEGER);
      INSERT INTO session_fixture VALUES (0);
    `);
    admitSqliteSchema(database);
    const transact = (write: () => void) => runSqliteImmediateTransactionSync(database, write);
    transact(() => {
      writeAuthProfileJsonCell(database, "store", kind, profileStore());
      writeAuthProfileJsonCell(database, "state", kind, { lastGood: {} });
    });
    const read = vi.fn(async () => readAuthProfileRows(database, databasePath, kind));
    const resolve = () =>
      cache.prepare(databasePath, { read, assertCurrent() {} }, "canonical").read();
    const first = await resolve();
    database.exec("UPDATE session_fixture SET value=value+1");
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledOnce();

    expect(() =>
      transact(() => {
        deleteAuthProfileJsonCell(database, "store", kind);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    // Rollback retires staged admission facts; the next read restores durable rows.
    const afterRollback = await resolve();
    expect(afterRollback).toEqual(first);
    expect(await resolve()).toBe(afterRollback);
    expect(read).toHaveBeenCalledTimes(2);

    const updatedState = { lastGood: { example: "example:key" } };
    transact(() => writeAuthProfileJsonCell(database, "state", kind, updatedState));
    if (kind === "shared-state") {
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        expect(readAuthProfileRows(database, databasePath, kind)).toMatchObject({
          store: { status: "readable", raw: profileStore() },
          state: { status: "readable", raw: updatedState },
        });
        expect(observation.queries).toHaveLength(1);
      } finally {
        observation.restore();
      }
    }
    expect((await resolve()).state).toEqual({ status: "readable", raw: updatedState });
    expect(read).toHaveBeenCalledTimes(3);
    transact(() => {
      deleteAuthProfileJsonCell(database, "state", kind);
      deleteAuthProfileJsonCell(database, "store", kind);
    });
    expect(await resolve()).toMatchObject({
      store: { status: "missing", reason: "row" },
      state: { status: "missing", reason: "row" },
    });
    expect(read).toHaveBeenCalledTimes(4);
  },
);

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
