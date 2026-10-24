import path from "node:path";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { describePeriod } from "./periods.js";
import { buildRoster } from "./roster.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const schemaPattern =
  /user_version|schema_version|sqlite_schema|sqlite_master|pragma_table|team_reports_schema_migrations|CREATE\s+(?:TABLE|INDEX)/i;
afterEach(() => vi.restoreAllMocks());

function openBackend(
  databasePath = path.join(tempDirs.make("team-reports-read-"), "reports.sqlite"),
) {
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  return { ...backend, [Symbol.dispose]: () => backend.close() };
}

it("reopens with live admitted persistent schema while creating fresh connection scratch", () => {
  const directory = tempDirs.make("team-reports-schema-admission-");
  const databasePath = path.join(directory, "reports.sqlite");
  // Warm admission lasts only while a native connection remains open.
  using owner = sqliteRuntime.openNodeSqliteDatabase(databasePath);
  expect(owner.isOpen).toBe(true);
  const open = sqliteRuntime.openNodeSqliteDatabase;
  const schemaStatements: string[] = [];
  vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = open(...args);
    const observe =
      <T>(run: (sql: string) => T) =>
      (sql: string) => {
        if (schemaPattern.test(sql)) {
          schemaStatements.push(sql);
        }
        return run(sql);
      };
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(observe(prepare));
    vi.spyOn(db, "exec").mockImplementation(observe(exec));
    return db;
  });
  for (let opened = 0; opened < 2; opened += 1) {
    schemaStatements.length = 0;
    using backend = openBackend(databasePath);
    if (opened === 0) {
      expect(schemaStatements.length).toBeGreaterThan(0);
    } else {
      expect(schemaStatements).toEqual([]);
    }
    expect(backend.execute({ type: "listPeriods", input: {} })).toEqual([]);
    backend.execute({ type: "resetActivity", input: undefined });
  }
});

it("aggregates across payload pages without paging metadata already retained for sorting", () => {
  using backend = openBackend();
  const period = describePeriod("day", "2026-08-20");
  const entries = Array.from({ length: 201 }, (_, index) => ({
    key: `comment-${index}`,
    value: {
      kind: "issue_comment" as const,
      actor: "alice",
      repo: "example/app",
      atMs: period.sinceMs + index,
      title: `Comment ${index}`,
      body: "Same discussion across all pages",
      url: `https://github.com/example/app/issues/1#comment-${index}`,
    },
  }));
  for (let start = 0; start < 201; start += 100) {
    backend.execute({
      type: "appendActivity",
      input: { source: "github", entries: entries.slice(start, start + 100) },
    });
  }
  const reads = vi.spyOn(sqliteRuntime, "executeSqliteQuerySync");
  const report = backend.execute({
    type: "aggregateActivity",
    input: {
      period,
      nowMs: period.untilMs,
      orgs: ["example"],
      roster: buildRoster([{ github: ["alice"] }]),
      githubStatus: { ok: true, warnings: [], stats: {} },
    },
  });
  expect(report).toMatchObject({
    totals: { github: { issueComments: 1 } },
    members: [{ login: "alice", github: { items: [{ title: "Comment 200" }] } }],
  });
  // Two source metadata reads plus three bounded payload reads.
  expect(reads.mock.calls.length).toBeLessThanOrEqual(5);
  const payloadSizes = reads.mock.results.flatMap((result) =>
    result.type === "return" &&
    result.value.rows.some(
      (row) => typeof row === "object" && row !== null && Object.hasOwn(row, "data_json"),
    )
      ? [result.value.rows.length]
      : [],
  );
  expect(payloadSizes.length).toBeGreaterThan(0);
  expect(Math.max(...payloadSizes)).toBeLessThanOrEqual(100);
});
