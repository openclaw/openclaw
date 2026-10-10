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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("shares immutable persisted rows across cache hits", async () => {
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
    cacheable: true,
  };
  const read = vi.fn(async () => rows);
  const cache = createRuntimeAuthProfileRowsCache(() => ({ rows: "1", selection: "1" }));
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
});

it("invalidates credential rows on writer-worker receipts without runtime freshness SQL", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-receipts-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
    INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  const broker = new SqliteWorkerBroker();
  const cache = createRuntimeAuthProfileRowsCache(() => ({ rows: "1", selection: "1" }));
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
