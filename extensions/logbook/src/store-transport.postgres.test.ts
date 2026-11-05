import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import {
  resolveDatabaseFamilyEngines,
  withDatabaseEngineSelection,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./store.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const schemaPrefix = `logbook_transport_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const observer = new Client({ connectionString: connection });
let store: LogbookStore | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    try {
      try {
        await store?.close();
      } finally {
        if (connection) {
          const schemas = await observer.query<{ nspname: string }>(
            "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
            [schemaPrefix.length + 1, `${schemaPrefix}_`],
          );
          for (const { nspname } of schemas.rows) {
            await observer.query(`DROP SCHEMA ${observer.escapeIdentifier(nspname)} CASCADE`);
          }
        }
      }
    } finally {
      try {
        await observer.end();
      } finally {
        cleanup();
      }
    }
  }),
);

describe.skipIf(!connection)("Logbook PostgreSQL worker transport", () => {
  beforeAll(async () => {
    await observer.connect();
  });

  it("reopens after a terminated write without replaying it or losing committed standups", async () => {
    const directory = realpathSync(tempDirs.make("logbook-transport-"));
    const databasePath = path.join(directory, "logbook.sqlite");
    const open = () =>
      withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { families: { logbook: { engine: "postgres" } } },
          }),
          postgres: { connection: connection!, schemaPrefix },
        },
        () => LogbookStore.open(directory, resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint)),
      );
    store = await open();
    let schema: string;
    {
      using anchor = new DatabaseSync(databasePath, { readOnly: true });
      const identity = anchor.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get();
      assert.equal(identity?.engine, "postgres");
      assert(typeof identity?.schema === "string");
      schema = identity.schema;
      expect(
        anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'standups'").all(),
      ).toEqual([]);
    }
    const table = `${observer.escapeIdentifier(schema)}.standups`;
    await store.saveStandup("2026-07-01", "committed before connection loss");
    await observer.query("BEGIN");
    let pending: Promise<unknown> | undefined;
    try {
      await observer.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const { rows: lockers } = await observer.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const lockerPid = lockers[0]!.pid;
      // Observe this operation's actual server wait, then terminate only that client.
      // Attach both handlers before polling so an early admission failure is still joined.
      pending = store.saveStandup("2026-07-02", "must not be replayed").then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      let waitingPid: number | undefined;
      await expect
        .poll(
          async () => {
            const { rows } = await observer.query<{ pid: number }>(
              `SELECT pid FROM pg_locks
               WHERE locktype = 'relation'
                 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND relation = $1::regclass AND mode = 'RowExclusiveLock' AND NOT granted
                 AND pid IS NOT NULL AND pid <> $2 AND $2 = ANY(pg_blocking_pids(pid))`,
              [table, lockerPid],
            );
            waitingPid = rows.length === 1 ? rows[0]!.pid : undefined;
            return rows.map(({ pid }) => pid);
          },
          { timeout: 5_000, interval: 20 },
        )
        .toEqual([expect.any(Number)]);
      assert(waitingPid !== undefined);
      expect(
        (await observer.query("SELECT pg_terminate_backend($1, 5000) AS terminated", [waitingPid]))
          .rows,
      ).toEqual([{ terminated: true }]);
      expect(await pending).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    } finally {
      try {
        await observer.query("ROLLBACK");
      } finally {
        await pending;
      }
    }
    expect(await store.getStandup("2026-07-02")).toBeNull();
    expect(await store.getStandup("2026-07-01")).toMatchObject({
      text: "committed before connection loss",
    });
    await store.saveStandup("2026-07-03", "committed after reopening");
    expect((await observer.query(`SELECT day, text FROM ${table} ORDER BY day`)).rows).toEqual([
      { day: "2026-07-01", text: "committed before connection loss" },
      { day: "2026-07-03", text: "committed after reopening" },
    ]);
    await store.close();
    store = await open();
    expect(await store.getStandup("2026-07-03")).toMatchObject({
      text: "committed after reopening",
    });
  });
});
