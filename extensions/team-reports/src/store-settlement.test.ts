import assert from "node:assert/strict";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { describePeriod } from "./periods.js";
import { githubItem } from "./reports-data.test-support.js";
import { buildRoster } from "./roster.js";
import { createSqliteWorkerBackend, openTeamReportsDatabase } from "./store.worker.js";

const captured = vi.hoisted(() => ({ databases: [] as DatabaseSync[] }));
// Observe the native handle while keeping real schema setup, SQL, and close behavior.
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      captured.databases.push(database);
      return database;
    },
  };
});

const closers: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    try {
      for (const close of closers.splice(0)) {
        close();
      }
    } finally {
      vi.restoreAllMocks();
      cleanup();
    }
  }),
);
const databasePath = () => path.join(tempDirs.make("team-reports-settlement-"), "reports.sqlite");

function retainClose(close: () => void) {
  let closed = false;
  const once = () => {
    if (!closed) {
      close();
      closed = true;
    }
  };
  closers.push(once);
  return once;
}

function open() {
  captured.databases.length = 0;
  const database = openTeamReportsDatabase(databasePath());
  const close = retainClose(database.close);
  const native = captured.databases[0];
  assert(native);
  return { database, native, close };
}

it("rejects unfinished transactions and a closed native owner", () => {
  const { database, native, close } = open();
  expect(() => database.assertSettled()).not.toThrow();
  native.exec("BEGIN");
  try {
    expect(() => database.assertSettled()).toThrow("unsettled transaction");
  } finally {
    native.exec("ROLLBACK");
  }
  expect(() => database.assertSettled()).not.toThrow();
  close();
  expect(() => database.assertSettled()).toThrow("Team Reports database is closed");
});

it("preserves collection scratch and a usable owner after an ordinary SQL failure", () => {
  const { database } = open();
  const period = describePeriod("day", "2026-08-18");
  database.appendActivity({ source: "github", entries: [{ key: "one", value: githubItem() }] });
  const run = {
    id: "run",
    kind: "manual" as const,
    startedAtMs: period.sinceMs,
    periods: [{ period: "day" as const, key: period.key }],
  };
  database.startRun(run);
  expect(() => database.assertSettled()).not.toThrow();
  expect(() => database.startRun(run)).toThrow();
  expect(() => database.assertSettled()).not.toThrow();
  expect(
    database.aggregateActivity({
      period,
      nowMs: period.untilMs,
      orgs: ["sample"],
      roster: buildRoster([{ github: ["alpha"] }]),
      githubStatus: { ok: true, warnings: [], stats: {} },
    }),
  ).toMatchObject({ totals: { github: { total: 1 } } });
  expect(database.listRuns()).toMatchObject([{ id: "run", status: "running" }]);
});

it("forwards native settlement failures through the real worker backend", () => {
  const backend = createSqliteWorkerBackend(undefined, { databasePath: databasePath() });
  const close = retainClose(backend.close);
  expect(backend.execute({ type: "listRuns", input: { limit: 20, filter: {} } })).toEqual([]);
  expect(() => backend.assertSettled()).not.toThrow();
  close();
  expect(() => backend.execute({ type: "listRuns", input: { limit: 20, filter: {} } })).toThrow();
  expect(() => backend.assertSettled()).toThrow("Team Reports database is closed");
});
