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
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const schemaPrefix = `workboard_recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const observer = new Client({ connectionString: connection });
let store: WorkboardStore | undefined;
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

describe.skipIf(!connection)("Workboard PostgreSQL worker recovery", () => {
  beforeAll(async () => {
    await observer.connect();
  });

  it("reopens after a terminated write without replay and preserves worker-domain errors", async () => {
    const directory = realpathSync(tempDirs.make("workboard-recovery-"));
    const databasePath = path.join(directory, "workboard.sqlite");
    const stores = withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines({
          database: { families: { workboard: { engine: "postgres" } } },
        }),
        postgres: { connection: connection!, schemaPrefix },
      },
      () =>
        createWorkboardSqliteStores({
          dbPath: databasePath,
          workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
        }),
    );
    store = new WorkboardStore(stores.cards, stores);
    await store.ready();
    let schema: string;
    {
      using anchor = new DatabaseSync(databasePath, { readOnly: true });
      const identity = anchor.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get();
      assert.equal(identity?.engine, "postgres");
      assert(typeof identity?.schema === "string");
      schema = identity.schema;
      expect(
        anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'workboard_boards'").all(),
      ).toEqual([]);
    }
    const table = `${observer.escapeIdentifier(schema)}.workboard_boards`;
    await store.upsertBoard({ id: "before", name: "Retained" });
    await expect(store.updateSessionsBoard("before", {})).rejects.toMatchObject({
      name: "Error",
      message: "This board is not a Sessions board.",
    });
    expect((await store.listBoards()).boards.map((board) => board.id)).toEqual([
      "default",
      "before",
    ]);

    await observer.query("BEGIN");
    let pending: Promise<unknown> | undefined;
    try {
      // Board registration reads before its UPSERT. SHARE allows those reads
      // while holding the actual write at RowExclusiveLock acquisition.
      await observer.query(`LOCK TABLE ${table} IN SHARE MODE`);
      const { rows: lockers } = await observer.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const lockerPid = lockers[0]!.pid;
      pending = store.upsertBoard({ id: "interrupted", name: "Must not replay" }).then(
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

    // The failed mutation invalidates the primed list; this request must reopen
    // storage through the same facade, without a manual close or retry.
    const recovered = (await store.listBoards()).boards;
    expect(recovered.map((board) => board.id)).toEqual(["default", "before"]);
    expect(recovered.find((board) => board.id === "before")).toMatchObject({ name: "Retained" });
    await expect(store.updateSessionsBoard("before", {})).rejects.toMatchObject({
      name: "Error",
      message: "This board is not a Sessions board.",
    });
    await store.upsertBoard({ id: "after", name: "Written after recovery" });
    expect((await observer.query(`SELECT id, name FROM ${table} ORDER BY id`)).rows).toEqual([
      { id: "after", name: "Written after recovery" },
      { id: "before", name: "Retained" },
    ]);
  });
});
