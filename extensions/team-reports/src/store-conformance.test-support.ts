import { expect } from "vitest";
import { describePeriod } from "./periods.js";
import { githubCounts } from "./reports.fixtures.js";
import { buildRoster } from "./roster.js";
import type { TeamReportsOperations } from "./store-contract.js";
import type { createSqliteWorkerBackend } from "./store.worker.js";
import type { ReportDocument } from "./types.js";

export function report(): ReportDocument {
  return {
    version: 1,
    period: describePeriod("day", "2026-08-20"),
    generatedAtMs: Date.parse("2026-08-21T00:00:00Z"),
    status: "closed",
    orgs: ["example"],
    memberCount: 2,
    activeMembers: 1,
    totals: {
      github: {
        ...githubCounts(41),
        commits: 11,
        prsOpened: 7,
        prsMerged: 5,
        securityAdvisories: 3,
      },
      discord: { messages: 13, channels: { general: 13 } },
    },
    members: ["alice", "bob"].map((login) => ({
      login,
      display: login,
      access: [],
      areas: [],
      aliases: [],
      github: { ...githubCounts(1), items: [] },
      discord: { total: 2, channels: { general: 2 }, excerpts: [] },
    })),
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: ["fixture warning"], stats: { apiCalls: 1 } } },
  };
}

export function exercise(backend: Pick<ReturnType<typeof createSqliteWorkerBackend>, "execute">) {
  const results: unknown[] = [];
  function call<K extends keyof TeamReportsOperations>(
    type: K,
    input: TeamReportsOperations[K]["input"],
  ) {
    // The worker dispatcher keeps the command's input and output union at its boundary.
    const result = backend.execute({ type, input } as Parameters<typeof backend.execute>[0]);
    results.push({ type, result: result === undefined ? null : result });
    return result;
  }
  call("resetActivity", undefined);
  const activity = {
    kind: "commit" as const,
    actor: "alice",
    repo: "example/app",
    title: "Initial",
    url: "https://example.test/commit/1",
    atMs: report().period.sinceMs + 1,
  };
  call("appendActivity", { source: "github", entries: [{ key: "a", value: activity }] });
  call("appendActivity", {
    source: "github",
    entries: [{ key: "a", value: { ...activity, title: "Updated" } }],
  });
  call("appendActivity", {
    source: "discord",
    entries: [
      {
        key: "d",
        value: {
          channelId: "general",
          channelName: "general",
          parentChannelId: "general",
          authorId: "1",
          authorIsBot: false,
          atMs: activity.atMs,
          content: "Example message",
        },
      },
    ],
  });
  const options = {
    period: report().period,
    nowMs: report().generatedAtMs,
    orgs: ["example"],
    roster: buildRoster([{ github: ["alice"], discordUserId: "1" }, { github: ["bob"] }]),
    githubStatus: { ok: true, warnings: [], stats: {} },
    discordConfig: { channels: [{ id: "general", excerpts: true }], excerptMaxChars: 260 },
  };
  const aggregate = call("aggregateActivity", options);
  expect(aggregate).toMatchObject({ totals: { github: { total: 1 }, discord: { messages: 1 } } });
  call("upsertPeriod", {
    report: report(),
    markdown: "original",
    summary: {
      source: "fallback",
      generatedAtMs: 1,
      globalSummary: "Fixture",
      highlights: [],
      fingerprint: "fixture",
      warnings: ["summary warning"],
    },
  });
  const periods = call("listPeriods", { period: "day", status: "closed", limit: 2 });
  expect(periods).toEqual([
    {
      period: "day",
      key: "2026-08-20",
      sinceMs: report().period.sinceMs,
      untilMs: report().period.untilMs,
      status: "closed",
      generatedAtMs: report().generatedAtMs,
      activeMembers: 1,
      memberCount: 2,
      githubTotal: 41,
      discordMessages: 13,
      commits: 11,
      prsOpened: 7,
      prsMerged: 5,
      securityAdvisories: 3,
    },
  ]);
  call("getPeriod", { period: "day", key: "2026-08-20" });
  call("getPeriodDocument", { period: "day", key: "2026-08-20" });
  call("latestSourceWarnings", undefined);
  call("latestPeople", undefined);
  call("listPersonDays", {
    login: "ALICE",
    options: { since: "2026-08-20", until: "2026-08-21", limit: 1 },
  });
  call("listPersonDaysSince", "2026-08-20");
  call("aggregatePeriod", { ...options, period: describePeriod("week", "2026-W34") });
  const refreshed = report();
  refreshed.members = [refreshed.members[0]!];
  call("upsertPeriod", { report: refreshed, markdown: "refreshed" });
  expect(call("listPersonDays", { login: "bob", options: {} })).toEqual([]);
  call("startRun", {
    id: "run",
    kind: "manual",
    startedAtMs: 1,
    periods: [{ period: "day", key: "2026-08-20" }],
  });
  call("finishRun", {
    id: "run",
    result: { finishedAtMs: 2, status: "ok", stats: { apiCalls: 2 } },
  });
  call("listRuns", { limit: 1, filter: { kind: "manual", status: "ok" } });
  call("prune", { retentionDays: 0, nowMs: report().generatedAtMs });
  call("prune", { retentionDays: 1, nowMs: report().generatedAtMs + 2 * 86_400_000 });
  expect(call("listPeriods", {})).toEqual([]);
  return results;
}
