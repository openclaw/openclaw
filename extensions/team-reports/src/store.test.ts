import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { githubCounts as counts } from "./reports.fixtures.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { PeriodDescriptor, ReportDocument, SummaryDocument } from "./types.js";

const DAY_MS = 86_400_000;
const resources: Array<{ store: TeamReportsStore; directory: string }> = [];

async function openStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-store-"));
  const store = await createTeamReportsStore({ stateDir: directory });
  resources.push({ directory, store });
  return { store, dbPath: path.join(directory, "plugins", "team-reports", "team-reports.sqlite") };
}

function report(key = "2026-08-20", logins = ["alice", "bob"]): ReportDocument {
  const sinceMs = Date.parse(`${key}T00:00:00Z`);
  return {
    version: 1,
    period: { period: "day", key, sinceMs, untilMs: sinceMs + DAY_MS, title: key },
    generatedAtMs: sinceMs + DAY_MS,
    status: "closed",
    orgs: ["example"],
    memberCount: logins.length,
    activeMembers: logins.length,
    totals: {
      github: counts(logins.length),
      discord: { messages: logins.length * 2, channels: { general: logins.length * 2 } },
    },
    members: logins.map((login) => ({
      login,
      display: login,
      access: [],
      areas: [],
      aliases: [],
      github: { ...counts(1), items: [] },
      discord: { total: 2, channels: { general: 2 }, excerpts: [] },
    })),
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: [], stats: { apiCalls: 1 } } },
  };
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
    const reopened = await createTeamReportsStore({ dbPath });
    try {
      expect(await reopened.getPeriod("day", "2026-08-20")).toEqual({
        report: report(),
        summary,
        markdown: "# Daily report",
      });
    } finally {
      await reopened.close();
    }
    await expect(store.listPeriods()).rejects.toThrow("store is closed");
  });

  it("replaces the document, summary, markdown, and person-day counts as one unit", async () => {
    const { store } = await openStore();
    await store.upsertPeriod({ report: report(), summary, markdown: "original" });
    expect(await store.listPersonDays("ALICE")).toMatchObject([
      { dayKey: "2026-08-20", githubTotal: 1, commits: 1, discordMessages: 2 },
    ]);
    await expect(
      store.upsertPeriod({
        report: report("2026-08-20", ["alice", "alice"]),
        markdown: "failed refresh",
      }),
    ).rejects.toThrow();
    expect((await store.getPeriod("day", "2026-08-20"))?.markdown).toBe("original");
    expect(await store.listPersonDays("bob")).toHaveLength(1);
    const refreshed = report("2026-08-20", ["alice"]);
    refreshed.members[0]!.github.commits = 3;
    refreshed.members[0]!.github.total = 3;
    refreshed.generatedAtMs += 1000;
    await store.upsertPeriod({ report: refreshed, markdown: "refreshed" });
    expect(await store.getPeriod("day", "2026-08-20")).toEqual({
      report: refreshed,
      summary: null,
      markdown: "refreshed",
    });
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

  it("lists stored totals for each period kind and reflects regenerated documents", async () => {
    const { store } = await openStore();
    for (const [period, key] of [
      ["day", "2026-08-20"],
      ["week", "2026-W34"],
      ["month", "2026-08"],
    ] as const) {
      const document = report();
      document.period = { ...document.period, period, key };
      document.activeMembers = 1;
      document.totals.github = {
        ...counts(21),
        commits: 3,
        prsOpened: 4,
        prsMerged: 5,
        securityAdvisories: 6,
      };
      document.totals.discord.messages = 7;
      await store.upsertPeriod({ report: document, markdown: key });
      expect(await store.listPeriods({ period })).toEqual([
        {
          period,
          key,
          sinceMs: Date.parse("2026-08-20T00:00:00Z"),
          untilMs: Date.parse("2026-08-21T00:00:00Z"),
          generatedAtMs: Date.parse("2026-08-21T00:00:00Z"),
          status: "closed",
          activeMembers: 1,
          memberCount: 2,
          githubTotal: 21,
          discordMessages: 7,
          commits: 3,
          prsOpened: 4,
          prsMerged: 5,
          securityAdvisories: 6,
        },
      ]);
    }
    await store.upsertPeriod({ report: report("2026-08-20", []), markdown: "refreshed" });
    expect((await store.listPeriods({ period: "day" }))[0]).toMatchObject({
      activeMembers: 0,
      memberCount: 0,
      githubTotal: 0,
      discordMessages: 0,
      commits: 0,
      prsOpened: 0,
      prsMerged: 0,
      securityAdvisories: 0,
    });
  });

  it("lists all logins since an inclusive day without the individual timeline limit", async () => {
    const { store } = await openStore();
    const logins = Array.from(
      { length: 30 },
      (_, index) => `member-${String(index).padStart(2, "0")}`,
    );
    await store.upsertPeriod({ report: report("2026-08-18", ["older"]), markdown: "older" });
    await store.upsertPeriod({ report: report("2026-08-19", logins), markdown: "boundary" });
    await store.upsertPeriod({ report: report("2026-08-20", ["latest"]), markdown: "latest" });
    const days = await store.listPersonDaysSince("2026-08-19");
    expect(days.map(({ dayKey, login }) => [dayKey, login])).toEqual([
      ["2026-08-20", "latest"],
      ...logins.map((login) => ["2026-08-19", login]),
    ]);
    expect(days[1]).toEqual({
      dayKey: "2026-08-19",
      login: "member-00",
      githubTotal: 1,
      commits: 1,
      prsOpened: 0,
      prsMerged: 0,
      prsClosed: 0,
      issuesOpened: 0,
      issuesClosed: 0,
      issueComments: 0,
      reviewComments: 0,
      discordMessages: 2,
    });
    expect(await store.listPersonDaysSince("2026-08-21")).toEqual([]);
  });

  it("reads half-open day ranges and indexes newest first without projecting week rows onto people", async () => {
    const { store } = await openStore();
    for (const key of ["2026-08-18", "2026-08-19", "2026-08-20"]) {
      await store.upsertPeriod({ report: report(key), markdown: key });
    }
    const week = report();
    week.period = {
      period: "week",
      key: "2026-W34",
      title: "Week 34",
      sinceMs: Date.parse("2026-08-17T00:00:00Z"),
      untilMs: Date.parse("2026-08-24T00:00:00Z"),
    };
    await store.upsertPeriod({ report: week, markdown: "week" });
    expect(
      (
        await store.getDayReports(
          Date.parse("2026-08-19T00:00:00Z"),
          Date.parse("2026-08-20T00:00:00Z"),
        )
      ).map((day) => day.period.key),
    ).toEqual(["2026-08-19"]);
    expect(
      (await store.listPeriods({ period: "day", limit: 2 })).map((entry) => entry.key),
    ).toEqual(["2026-08-20", "2026-08-19"]);
    expect(
      (await store.listPersonDays("alice", { since: "2026-08-18", until: "2026-08-20" })).map(
        (day) => day.dayKey,
      ),
    ).toEqual(["2026-08-19", "2026-08-18"]);
    expect(await store.getPeriod("month", "2026-08")).toBeUndefined();
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
    const periods: PeriodDescriptor[] = [
      {
        period: "week",
        key: "2026-W33",
        title: "Older week",
        sinceMs: Date.parse("2026-08-10T00:00:00Z"),
        untilMs: Date.parse("2026-08-17T00:00:00Z"),
      },
      {
        period: "month",
        key: "2026-08",
        title: "Overlapping month",
        sinceMs: Date.parse("2026-08-01T00:00:00Z"),
        untilMs: Date.parse("2026-09-01T00:00:00Z"),
      },
    ];
    for (const period of periods) {
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
