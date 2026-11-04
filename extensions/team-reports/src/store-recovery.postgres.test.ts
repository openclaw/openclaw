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
import { describePeriod } from "./periods.js";
import { githubItem } from "./reports-data.test-support.js";
import { buildRoster } from "./roster.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const schemaPrefix = `team_recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const observer = new Client({ connectionString: connection });
let store: TeamReportsStore | undefined;
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

describe.skipIf(!connection)("Team Reports PostgreSQL worker recovery", () => {
  beforeAll(async () => {
    await observer.connect();
  });

  it("reopens after a terminated write without replay and with fresh collection scratch", async () => {
    const directory = realpathSync(tempDirs.make("team-reports-recovery-"));
    const databasePath = path.join(directory, "anchor.sqlite");
    store = await withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines({
          database: { families: { "team-reports": { engine: "postgres" } } },
        }),
        postgres: { connection: connection!, schemaPrefix },
      },
      () =>
        createTeamReportsStore({
          dbPath: databasePath,
          workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
        }),
    );
    let schema: string;
    {
      using anchor = new DatabaseSync(databasePath, { readOnly: true });
      const identity = anchor.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get();
      assert.equal(identity?.engine, "postgres");
      assert(typeof identity?.schema === "string");
      schema = identity.schema;
      expect(
        anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'team_reports_runs'").all(),
      ).toEqual([]);
    }
    const table = `${observer.escapeIdentifier(schema)}.team_reports_runs`;
    await store.startRun({ id: "retained", kind: "manual", startedAtMs: 1, periods: [] });
    const period = describePeriod("day", "2026-08-20");
    const aggregation = {
      period,
      nowMs: period.untilMs,
      orgs: ["example"],
      roster: buildRoster([{ github: ["alice"] }]),
      githubStatus: { ok: true, warnings: [], stats: {} },
    };
    await store.appendActivity({
      source: "github",
      entries: [
        { key: "collected", value: githubItem({ actor: "alice", atMs: period.sinceMs + 1 }) },
      ],
    });
    expect((await store.aggregateActivity(aggregation)).totals.github.total).toBe(1);

    await observer.query("BEGIN");
    let pending: Promise<unknown> | undefined;
    try {
      await observer.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const { rows: lockers } = await observer.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const lockerPid = lockers[0]!.pid;
      // Target the fixture's actual blocked write, and join early failures as well.
      pending = store
        .startRun({ id: "interrupted", kind: "manual", startedAtMs: 2, periods: [] })
        .then(
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

    // The same public object must recover on its next request, with no manual reopen or retry.
    expect((await store.listRuns()).map((run) => run.id)).toEqual(["retained"]);
    expect((await store.aggregateActivity(aggregation)).totals.github.total).toBe(0);
    await store.startRun({ id: "after", kind: "manual", startedAtMs: 3, periods: [] });
    expect((await observer.query(`SELECT id FROM ${table} ORDER BY started_at_ms`)).rows).toEqual([
      { id: "retained" },
      { id: "after" },
    ]);
  });
});
