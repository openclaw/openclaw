import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveDatabaseFamilyEngines,
  withDatabaseEngineSelection,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import {
  fixtureChannels,
  fixtureDay,
  fixturePeople,
} from "./report-run.benchmark-fixtures.test-support.js";
import { githubItem, reportDocument, reportMember } from "./reports-data.test-support.js";
import { buildRoster } from "./roster.js";
import { TeamReportsRunner } from "./run-worker.js";
import { TeamReportsScheduler } from "./scheduler.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";

const collectionExit = vi.hoisted(() => ({ notify: () => {} }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        if (String(args[0]).endsWith("/report-run.benchmark-worker.test-support.ts")) {
          this.once("exit", () => collectionExit.notify());
        }
      }
    },
  };
});

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

function openStore(databasePath: string) {
  return withDatabaseEngineSelection(
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
}

describe.skipIf(!connection)("Team Reports PostgreSQL worker recovery", () => {
  beforeAll(async () => {
    await observer.connect();
  });

  afterEach(async () => {
    try {
      await store?.close();
      store = undefined;
    } finally {
      collectionExit.notify = () => {};
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("reopens after a terminated write without replay and with fresh collection scratch", async () => {
    const directory = realpathSync(tempDirs.make("team-reports-recovery-"));
    const databasePath = path.join(directory, "anchor.sqlite");
    store = await openStore(databasePath);
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

  it("drains cancelled collection before recording failure and closing its PostgreSQL store", async () => {
    const directory = realpathSync(tempDirs.make("team-reports-collection-stop-"));
    const databasePath = path.join(directory, "anchor.sqlite");
    store = await openStore(databasePath);
    const periods = [describePeriod("day", fixtureDay), describePeriod("month", fixtureDay)];
    const accepted = periods.map((period) => ({
      report: reportDocument([reportMember("person-0")], { period, orgs: ["fixture"] }),
      summary: null,
      markdown: "Previously accepted report",
    }));
    for (const document of accepted) {
      await store.upsertPeriod(document);
    }
    const config = parseTeamReportsConfig({
      github: { token: "synthetic-fixture", orgs: ["fixture"] },
      discord: { token: "synthetic-fixture", guildId: "1000", channels: fixtureChannels },
      people: fixturePeople,
      summaries: { enabled: true },
      schedule: { enabled: false, weekly: false, monthly: true },
    });
    const resolved = await resolveTeamReportsConfig(config, {});
    const workerUrl = new URL("./report-run.benchmark-worker.test-support.ts", import.meta.url);
    const runner = new TeamReportsRunner(workerUrl);
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const cancelled = createDeferred<void>();
    const exited = createDeferred<void>();
    collectionExit.notify = () => exited.resolve();
    const execute = store.execute.bind(store);
    let held = false;
    const calls = vi.spyOn(store, "execute").mockImplementation(async (...args) => {
      if (args[0] !== "appendActivity" || held) {
        return execute(...args);
      }
      held = true;
      args[2]?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      const result = await execute(...args);
      // The real PostgreSQL append committed; cancellation still owes this host result delivery.
      entered.resolve();
      await released.promise;
      return result;
    });
    const close = vi.spyOn(store, "close");
    const complete = vi.fn(async () => {
      throw new Error("Cancelled collection must not start a model request");
    });
    const context = {
      scheduler: createTestPluginServiceScheduler(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      serviceHealth: { reportFailure: vi.fn(), clearFailure: vi.fn() },
    };
    const scheduler = new TeamReportsScheduler({
      config,
      resolved,
      store,
      llm: { complete },
      context,
      runReports: (params) => runner.run(params),
      closeRunner: () => runner.close(),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stopped: Promise<void> | undefined;
    let stopSettled = false;
    let id: string;
    try {
      await scheduler.start();
      id = await scheduler.generate({ date: fixtureDay });
      await entered.promise;
      stopped = scheduler.stop().then(() => {
        stopSettled = true;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([cancelled.promise, exited.promise]);
      await setImmediate();
      expect(stopSettled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(context.serviceHealth.reportFailure).not.toHaveBeenCalled();
      released.resolve();
      await stopped;
      expect(close).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      expect(calls.mock.calls.map(([command]) => command)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^(aggregateActivity|aggregatePeriod|upsertPeriod)$/),
        ]),
      );
      expect(context.serviceHealth.reportFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Team Reports stopped after 30 seconds" }),
      );
      expect(context.logger.error).toHaveBeenCalledWith(
        "team-reports: Team Reports stopped after 30 seconds",
      );
      expect(context.serviceHealth.clearFailure).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await (stopped ?? scheduler.stop());
      vi.useRealTimers();
    }
    store = await openStore(databasePath);
    expect((await store.listRuns()).find((run) => run.id === id)).toMatchObject({
      status: "error",
      error: "Team Reports stopped after 30 seconds",
    });
    for (const document of accepted) {
      const { period, key } = document.report.period;
      expect(await store.getPeriod(period, key)).toEqual(document);
    }
    const next = new TeamReportsRunner(workerUrl);
    try {
      const statuses = await next.run({
        config: { ...config, summaries: { ...config.summaries, enabled: false } },
        resolved,
        store,
        periods,
        llm: { complete },
        runtime: { logger: context.logger, signal: new AbortController().signal },
        onRoster() {},
      });
      expect(Object.values(statuses).every((source) => source.ok)).toBe(true);
      for (const { period, key } of periods) {
        expect((await store.getPeriod(period, key))?.report.totals).toMatchObject({
          github: { issuesOpened: 2000, commits: 1000 },
          discord: { messages: 1500 },
        });
      }
    } finally {
      await next.close();
    }
  });
});
