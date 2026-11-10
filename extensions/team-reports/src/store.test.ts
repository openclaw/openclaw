import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { describePeriod } from "./periods.js";
import { githubItem, reportDocument, reportMember } from "./reports-data.test-support.js";
import { githubCounts as counts } from "./reports.fixtures.js";
import { buildRoster } from "./roster.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { ReportDocument, SummaryDocument } from "./types.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint);
const resources: Array<{ store: TeamReportsStore; directory: string }> = [];

async function openStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-store-"));
  const store = await createTeamReportsStore({ stateDir: directory, workerModuleUrl });
  resources.push({ directory, store });
  return { store, dbPath: path.join(directory, "plugins", "team-reports", "team-reports.sqlite") };
}

function report(key = "2026-08-20", logins = ["alice", "bob"]): ReportDocument {
  return reportDocument(
    logins.map((login) =>
      reportMember(login, { discord: { total: 2, channels: { general: 2 }, excerpts: [] } }),
    ),
    {
      period: describePeriod("day", key),
      totals: {
        github: counts(logins.length),
        discord: { messages: logins.length * 2, channels: { general: logins.length * 2 } },
      },
      sources: { github: { ok: true, warnings: [], stats: { apiCalls: 1 } } },
    },
  );
}

async function expectStored(
  store: TeamReportsStore,
  document: ReportDocument,
  markdown: string,
  storedSummary: SummaryDocument | null = null,
) {
  const { period, key } = document.period;
  const expected = { report: document, summary: storedSummary };
  expect(await store.getPeriod(period, key)).toEqual({ ...expected, markdown });
  expect(await store.getPeriodDocument(period, key)).toEqual(expected);
}

async function readFailure(read: Promise<unknown>) {
  const error = await read.catch((caught: unknown) => caught);
  if (!(error instanceof Error)) {
    throw new Error("The period read must reject this fixture");
  }
  return { name: error.name, message: error.message };
}

const summary: SummaryDocument = {
  source: "fallback",
  generatedAtMs: 1,
  globalSummary: "Two contributors were active.",
  highlights: ["Changes in example/project."],
  fingerprint: "fixture-fingerprint",
  warnings: ["Model summary unavailable: completion failed"],
};

afterEach(async () => {
  for (const { store, directory } of resources.splice(0)) {
    await store.close();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Team Reports storage", () => {
  it("creates private STRICT tables and reopens durable reports with summary warnings in WAL mode", async () => {
    const { store, dbPath } = await openStore();
    await store.upsertPeriod({ report: report(), summary, markdown: "# Daily report" });
    const database = openNodeSqliteDatabase(dbPath);
    try {
      const tables = database
        .prepare("PRAGMA table_list")
        .all()
        .filter((row) => typeof row.name === "string" && row.name.startsWith("team_reports_"));
      expect(tables).toHaveLength(4);
      expect(tables.every((row) => row.strict === 1)).toBe(true);
      expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
        for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      database.close();
    }
    await store.close();
    const reopened = await createTeamReportsStore({ dbPath, workerModuleUrl });
    try {
      await expectStored(reopened, report(), "# Daily report", summary);
      expect((await reopened.latestPeople())?.members.map((member) => member.login)).toEqual([
        "alice",
        "bob",
      ]);
    } finally {
      await reopened.close();
    }
    await expect(store.listPeriods()).rejects.toThrow("store is closed");
    await expect(store.getPeriodDocument("day", "2026-08-20")).rejects.toThrow("store is closed");
  });

  it("keeps timers responsive during lock contention and drains admitted writes before closing", async () => {
    const { store, dbPath } = await openStore();
    const retained = await createTeamReportsStore({ dbPath, workerModuleUrl });
    const blocker = openNodeSqliteDatabase(dbPath);
    let released = false;
    blocker.exec("BEGIN IMMEDIATE");
    const release = setTimeout(() => {
      blocker.exec("ROLLBACK");
      released = true;
    }, 20);
    try {
      const write = store.upsertPeriod({ report: report(), markdown: "drained before close" });
      const closing = store.close().then(() => expect(released).toBe(true));
      await expect(store.listPeriods()).rejects.toThrow("store is closed");
      await Promise.all([write, closing]);
      expect(released).toBe(true);
    } finally {
      clearTimeout(release);
      if (!released) {
        blocker.exec("ROLLBACK");
      }
      blocker.close();
      await retained.close();
    }
    const reopened = await createTeamReportsStore({ dbPath, workerModuleUrl });
    try {
      expect((await reopened.getPeriod("day", "2026-08-20"))?.markdown).toBe(
        "drained before close",
      );
    } finally {
      await reopened.close();
    }
  });

  it("replaces the document, summary, markdown, and person-day counts as one unit", async () => {
    const { store } = await openStore();
    await store.upsertPeriod({ report: report(), summary, markdown: "original" });
    expect(await store.listPersonDays("ALICE")).toMatchObject([
      { dayKey: "2026-08-20", githubTotal: 1, commits: 1, discordMessages: 2 },
    ]);
    const lateDuplicate = [
      "alice",
      ...Array.from({ length: 3000 }, (_, index) => `new-${index}`),
      "ALICE",
    ];
    for (const logins of [["alice", "alice"], lateDuplicate]) {
      await expect(
        store.upsertPeriod({
          report: report("2026-08-20", logins),
          markdown: "failed refresh",
        }),
      ).rejects.toThrow();
      await expectStored(store, report(), "original", summary);
      expect((await store.listPersonDaysSince("2026-08-20")).map((day) => day.login)).toEqual([
        "alice",
        "bob",
      ]);
    }
    const refreshed = report("2026-08-20", ["alice"]);
    refreshed.members[0]!.github.commits = 3;
    refreshed.members[0]!.github.total = 3;
    refreshed.generatedAtMs += 1000;
    await store.upsertPeriod({ report: refreshed, markdown: "refreshed" });
    await expectStored(store, refreshed, "refreshed");
    expect((await store.listPersonDays("alice"))[0]).toMatchObject({ githubTotal: 3, commits: 3 });
    expect(await store.listPersonDays("bob")).toEqual([]);
  });

  it("rejects a report exceeding the UTF-8 byte limit without replacing existing data", async () => {
    const { store } = await openStore();
    await store.upsertPeriod({ report: report(), markdown: "kept" });
    const oversized = report();
    oversized.period.title = "é".repeat(1024 * 1024);
    await expect(store.upsertPeriod({ report: oversized, markdown: "too large" })).rejects.toThrow(
      "2 MiB",
    );
    expect((await store.getPeriod("day", "2026-08-20"))?.markdown).toBe("kept");
    expect(await store.listPersonDays("alice")).toHaveLength(1);
  });

  it("lists all logins since an inclusive day without the individual timeline limit", async () => {
    const { store } = await openStore();
    const logins = Array.from(
      { length: 3000 },
      (_, index) => `member-${String(index).padStart(4, "0")}`,
    );
    await store.upsertPeriod({ report: report("2026-08-18", ["older"]), markdown: "older" });
    await store.upsertPeriod({ report: report("2026-08-19", logins), markdown: "boundary" });
    await store.upsertPeriod({ report: report("2026-08-20", ["latest"]), markdown: "latest" });
    const days = await store.listPersonDaysSince("2026-08-19");
    expect(days.map(({ dayKey, login }) => [dayKey, login])).toEqual([
      ["2026-08-20", "latest"],
      ...logins.map((login) => ["2026-08-19", login]),
    ]);
    expect(days[1]).toMatchObject({ githubTotal: 1, commits: 1, discordMessages: 2 });
    expect(await store.listPersonDaysSince("2026-08-21")).toEqual([]);
    await store.upsertPeriod({ report: report("2026-08-19", []), markdown: "empty roster" });
    expect((await store.listPersonDaysSince("2026-08-19")).map((day) => day.login)).toEqual([
      "latest",
    ]);
    expect((await store.getPeriod("day", "2026-08-19"))?.report.members).toEqual([]);
  });

  it("reads half-open day ranges and indexes newest first without projecting week rows onto people", async () => {
    const { store } = await openStore();
    for (const [index, key] of ["2026-08-18", "2026-08-19", "2026-08-20"].entries()) {
      const day = report(key);
      day.totals.github = counts((index + 1) * day.members.length);
      for (const member of day.members) {
        member.github = { ...counts(index + 1), items: [] };
      }
      await store.upsertPeriod({ report: day, markdown: key });
    }
    const week = report();
    week.period = describePeriod("week", "2026-W34");
    await store.upsertPeriod({ report: week, markdown: "week" });
    const aggregated = await store.aggregatePeriod({
      period: {
        ...week.period,
        sinceMs: Date.parse("2026-08-19T00:00:00Z"),
        untilMs: Date.parse("2026-08-20T00:00:00Z"),
      },
      nowMs: week.period.untilMs,
      orgs: ["example"],
      roster: buildRoster([{ github: ["alice"] }, { github: ["bob"] }]),
    });
    expect(aggregated.totals.github.total).toBe(4);
    expect(aggregated.members.map((member) => [member.login, member.github.total])).toEqual([
      ["alice", 2],
      ["bob", 2],
    ]);
    expect(
      (await store.listPeriods({ period: "day", limit: 2 })).map((entry) => entry.key),
    ).toEqual(["2026-08-20", "2026-08-19"]);
    expect(
      (await store.listPersonDays("alice", { since: "2026-08-18", until: "2026-08-20" })).map(
        (day) => day.dayKey,
      ),
    ).toEqual(["2026-08-19", "2026-08-18"]);
    expect(await store.getPeriod("month", "2026-08")).toBeUndefined();
    expect(await store.getPeriodDocument("month", "2026-08")).toBeUndefined();
  });

  it.each([
    ["report member schema", "data_json", JSON.stringify({ ...report(), members: "invalid" })],
    ["report JSON syntax", "data_json", "{"],
    ["summary schema", "summary_json", JSON.stringify({ ...summary, globalSummary: 123 })],
    ["summary JSON syntax", "summary_json", "{"],
    ["unsafe until timestamp", "until_ms", 9_007_199_254_740_992],
    [
      "unsafe extracted total",
      "data_json",
      JSON.stringify({ ...report(), activeMembers: 9_007_199_254_740_992 }),
    ],
  ])("preserves latest warning and people failures for %s", async (failure, column, value) => {
    const { store, dbPath } = await openStore();
    await store.upsertPeriod({ report: report(), summary, markdown: "kept" });
    const database = openNodeSqliteDatabase(dbPath);
    try {
      const data = report();
      if (column === "until_ms") {
        database.exec(`UPDATE team_reports_periods SET until_ms = ${value}`);
      } else {
        database.prepare(`UPDATE team_reports_periods SET ${column} = ?`).run(value);
      }
      const originalRead = async () => {
        const latest = (await store.listPeriods({ period: "day", limit: 1 }))[0];
        return latest ? store.getPeriod("day", latest.key) : undefined;
      };
      const originalError = await readFailure(originalRead());
      await expect(store.latestSourceWarnings()).rejects.toMatchObject(originalError);
      await expect(store.latestPeople()).rejects.toMatchObject(originalError);
      if (failure === "unsafe extracted total") {
        // Direct document reads validate JSON numbers without SQLite's integer extraction.
        expect(await store.getPeriodDocument("day", "2026-08-20")).toEqual({
          report: { ...data, activeMembers: 9_007_199_254_740_992 },
          summary,
        });
      } else {
        const directError = await readFailure(store.getPeriod("day", "2026-08-20"));
        await expect(store.getPeriodDocument("day", "2026-08-20")).rejects.toMatchObject(
          directError,
        );
      }
    } finally {
      database.close();
    }
  });

  it("records run outcomes once, including bounded failures and collector statistics", async () => {
    const { store } = await openStore();
    await store.startRun({
      id: "first",
      kind: "manual",
      startedAtMs: 1,
      periods: [{ period: "day", key: "2026-08-20" }],
    });
    await store.startRun({ id: "second", kind: "intraday", startedAtMs: 2, periods: [] });
    await store.finishRun("first", {
      finishedAtMs: 3,
      status: "error",
      error: "x".repeat(3000),
      stats: { apiCalls: 2 },
    });
    expect(await store.listRuns()).toMatchObject([
      { id: "second", status: "running", finishedAtMs: null },
      {
        id: "first",
        status: "error",
        finishedAtMs: 3,
        stats: { apiCalls: 2 },
        periods: [{ period: "day", key: "2026-08-20" }],
      },
    ]);
    expect((await store.listRuns())[1]?.error).toHaveLength(2000);
    expect(
      (await store.listRuns(1, { kind: "manual", status: "error" })).map((run) => run.id),
    ).toEqual(["first"]);
    await expect(store.finishRun("first", { finishedAtMs: 4, status: "ok" })).rejects.toThrow(
      "not running",
    );
    await store.finishRun("second", { finishedAtMs: 4, status: "ok" });
    expect(await store.listRuns(1)).toMatchObject([{ id: "second", status: "ok", periods: [] }]);
  });

  it("prunes old complete periods and person days, retaining overlap, active runs, and keep-all state", async () => {
    const { store } = await openStore();
    for (const key of ["2026-08-15", "2026-08-16", "2026-08-17"]) {
      await store.upsertPeriod({ report: report(key, ["alice"]), markdown: key });
    }
    for (const period of [describePeriod("week", "2026-W33"), describePeriod("month", "2026-08")]) {
      await store.upsertPeriod({ report: { ...report(), period }, markdown: period.title });
    }
    await store.startRun({ id: "old-complete", kind: "closed-day", startedAtMs: 1, periods: [] });
    await store.finishRun("old-complete", { finishedAtMs: 2, status: "ok" });
    await store.startRun({ id: "running", kind: "manual", startedAtMs: 3, periods: [] });
    const now = Date.parse("2026-08-20T13:00:00Z");
    expect(await store.prune(0, now)).toEqual({ periods: 0, personDays: 0, runs: 0 });
    expect(await store.listPeriods()).toHaveLength(5);
    expect(await store.prune(3, now)).toEqual({ periods: 3, personDays: 2, runs: 1 });
    expect((await store.listPeriods()).map((entry) => entry.key)).toEqual([
      "2026-08-17",
      "2026-08",
    ]);
    expect((await store.listPersonDays("alice")).map((day) => day.dayKey)).toEqual(["2026-08-17"]);
    expect((await store.listRuns()).map((run) => run.id)).toEqual(["running"]);
  });
});

it("replaces streamed activity across batches and clears it on reset", async () => {
  const { store } = await openStore();
  const period = describePeriod("day", "2026-08-20");
  const options = {
    period,
    nowMs: period.untilMs,
    orgs: ["sample"],
    roster: buildRoster([{ github: ["alpha"] }]),
    githubStatus: { ok: true, warnings: [], stats: {} },
  };
  for (const title of ["Original", "Updated"]) {
    const value = githubItem({ title, atMs: period.sinceMs + 1 });
    await store.appendActivity({ source: "github", entries: [{ key: "same", value }] });
  }
  const result = await store.aggregateActivity(options);
  expect(result.totals.github.total).toBe(1);
  expect(result.members[0]?.github.items).toMatchObject([{ title: "Updated" }]);
  await store.resetActivity();
  expect((await store.aggregateActivity(options)).totals.github.total).toBe(0);
});
