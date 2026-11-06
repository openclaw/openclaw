import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, describePeriod } from "../periods.js";
import { githubItem, reportDocument, reportMember } from "../reports-data.test-support.js";
import { githubCounts } from "../reports.fixtures.js";
import type { PeriodListEntry, PersonDay } from "../store.js";
import type { Period, Person, PersonReport, ReportDocument } from "../types.js";
import type { PersonWorkSessions } from "../work-sessions.js";
import {
  renderIndexPage,
  renderPeoplePage,
  renderPersonPage,
  renderReportPage,
  type PageContext,
  type PeriodIndex,
} from "./html.js";

const NOW_MS = Date.parse("2026-09-07T16:44:00Z");
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW_MS));
afterEach(() => vi.restoreAllMocks());

const ctx: PageContext = {
  basePath: "/reports",
  nonce: "fixture",
  absoluteUrl: "https://example.test/reports/",
  displayTimezone: "America/Los_Angeles",
};
function contains(html: string | undefined, ...texts: string[]) {
  for (const text of texts) {
    expect(html).toContain(text);
  }
}
function excludes(html: string | undefined, ...texts: string[]) {
  for (const text of texts) {
    expect(html).not.toContain(text);
  }
}
function makeMember(total = 10, overrides: Partial<PersonReport> = {}): PersonReport {
  return reportMember("alice", {
    display: "Alice",
    github: { ...githubCounts(total), items: [] },
    discord: { total, channels: total ? { general: total } : {}, excerpts: [] },
    ...overrides,
  });
}
function entry(period: Period, key: string, total = 10): PeriodListEntry {
  const window = describePeriod(period, key);
  return {
    ...githubCounts(total),
    ...window,
    status: window.untilMs > NOW_MS ? "partial" : "closed",
    generatedAtMs: Math.min(window.untilMs, NOW_MS),
    activeMembers: 1,
    memberCount: 2,
    githubTotal: total,
    discordMessages: total,
  };
}
const day = (key: string, total = 10) => entry("day", key, total);
const partialCard = 'class="quick-card oc-card oc-card-interactive partial"';
function document(period: Period = "day", key = "2026-09-07"): ReportDocument {
  const row = entry(period, key);
  return reportDocument([makeMember()], {
    period: describePeriod(period, key),
    status: row.status,
    generatedAtMs: row.generatedAtMs,
    memberCount: 2,
    activeMembers: 1,
    totals: { github: githubCounts(10), discord: { messages: 10, channels: { general: 10 } } },
    sources: { github: { ok: true, warnings: [], stats: { reposScanned: 1 } } },
  });
}
function reportPage(report: ReportDocument, history: PeriodListEntry[] = []) {
  return renderReportPage(ctx, report, null, history);
}
const homeOptions = { orgs: ["example"], health: { running: true, warnings: 0 } };
function home(
  index: Partial<PeriodIndex>,
  options: Parameters<typeof renderIndexPage>[2] = homeOptions,
): string {
  return renderIndexPage(ctx, { day: [], week: [], month: [], ...index }, options);
}
function personDay(login: string, dayKey: string, total: number): PersonDay {
  return { ...githubCounts(total), login, dayKey, githubTotal: total, discordMessages: total };
}
function sessions(login: string, label: string): PersonWorkSessions {
  return { available: true, sessions: [{ key: `agent:main:${login}-work`, label }] };
}

describe("Team Reports site behavior", () => {
  it("shows a dateline only with multiple stored days and keeps the whole retained range", () => {
    excludes(home({ day: [day("2026-09-07")] }), 'aria-label="Activity dateline"');
    const days = Array.from({ length: 400 }, (_, index) =>
      day(new Date(Date.parse("2026-09-07T00:00:00Z") - index * DAY_MS).toISOString().slice(0, 10)),
    );
    const html = home({ day: days });
    contains(html, 'aria-label="Activity dateline"', "400 report days");
    contains(html, 'href="/reports/day/2026-09-07/"', days.at(-1)!.key);
  });

  it("uses UTC windows for open guidance and countdowns", () => {
    const html = home({ day: [day("2026-09-07"), day("2026-09-06")] });
    contains(html, "Open reporting windows", "Today, as of");
    contains(html, "16:44 UTC", "closes in 7h 16m (00:00 UTC)");
  });
  it.each([
    ["2026-09-07", "partial", false, "Intraday"],
    ["2026-09-07", "partial", true, ""],
    ["2026-09-07", "closed", false, ""],
    ["2026-09-06", "partial", false, "Incomplete"],
    ["2026-09-06", "closed", true, ""],
  ] as const)("preserves completeness for %s/%s (at end: %s)", (key, status, atEnd, badge) => {
    const row = day(key);
    const html = home({
      day: [{ ...row, status, generatedAtMs: atEnd ? row.untilMs : row.generatedAtMs }],
    });
    expect(html.includes(partialCard)).toBe(status === "partial");
    expect(html.includes("Open reporting windows")).toBe(key === "2026-09-07");
    for (const label of ["Intraday", "Incomplete"]) {
      expect(html.match(new RegExp(`>${label}</span>`, "g")) ?? []).toHaveLength(
        label === badge ? 2 : 0,
      );
    }
    if (badge === "Incomplete") {
      expect(html.match(/oc-badge-warning[^>]*>Incomplete<\/span>/g)).toHaveLength(2);
    }
  });

  it("compares an open aggregate snapshot to elapsed prior days instead of the full period", () => {
    const previous = entry("week", "2026-W36", 100);
    const current = entry("week", "2026-W37", 15);
    const html = home({ day: [day("2026-08-31")], week: [current, previous] });
    expect(html).toContain("+50% vs prev week to date");
    const monthDays = Array.from({ length: 7 }, (_, index) =>
      day(`2026-08-${String(index + 1).padStart(2, "0")}`, 1),
    );
    expect(
      home({
        day: monthDays,
        month: [entry("month", "2026-09", 14), entry("month", "2026-08", 100)],
      }),
    ).toContain("+100% vs prev month to date");
    expect(home({ week: [current, previous] })).toContain("-85% vs prev week");
    expect(home({ day: [day("2026-09-07", 20), day("2026-09-06")] })).toContain(
      "+100% vs prev day",
    );
  });

  it.each([
    ["day", 7, (i: number) => `2026-08-${31 - i}`],
    ["week", 12, (i: number) => `2026-W${34 - i}`],
    [
      "month",
      12,
      (i: number) => `${2026 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}`,
    ],
  ] as const)("offers Show all only above the visible %s history limit", (period, count, key) => {
    const entries = Array.from({ length: count + 1 }, (_, i) => entry(period, key(i)));
    expect(home({ [period]: entries.slice(0, count) })).not.toContain(`data-toggle="${period}"`);
    const html = home({ [period]: entries });
    contains(html, `Show all ${count + 1}`, " data-extra hidden");
    expect(html).toContain(`href="/reports/${period}/${key(count)}/"`);
  });

  it.each(["2026-09-07", "2026-09-06"])("compares %s only to earlier reports", (key) => {
    const report = document("day", key);
    const prior = new Date(report.period.sinceMs - DAY_MS).toISOString().slice(0, 10);
    const html = reportPage(report, [day("2026-09-08", 100), day(key), day(prior, 5)]);
    const suffix = key === "2026-09-07" ? " (in progress)" : "";
    expect(html).toContain(`+100% vs prev day${suffix}`);
    expect(html.includes("(in progress)")).toBe(key === "2026-09-07");
  });

  it("ranks member distribution by activity and exposes members after the first twelve", () => {
    const report = document();
    report.members = Array.from({ length: 14 }, (_, index) =>
      makeMember(index + 1, {
        login: `member-${index}`,
        display: `Member ${index}`,
        discord: { total: 0, channels: {}, excerpts: [] },
      }),
    );
    const html = reportPage(report);
    const distribution = html.slice(
      html.indexOf("Activity by Member"),
      html.indexOf("data-maintainer-filter-root"),
    );
    expect(distribution.indexOf("member-13")).toBeLessThan(distribution.indexOf("member-12"));
    expect(distribution).toContain("Show remaining 2");
  });

  it("keeps every retained GitHub item accessible beyond the three-item preview", () => {
    const report = document();
    const member = report.members[0]!;
    member.github.items = ["First", "Second", "Third", "<Fourth>"].map((title, index) =>
      githubItem({
        kind: "pr_opened",
        repo: `example/repo-${index}`,
        title,
        url: `https://github.com/example/repo-${index}/pull/1`,
      }),
    );
    member.github.items[3]!.repo = "example/<hostile-repo>";
    member.github.items[3]!.url = "javascript:alert(1)";
    const html = reportPage(report);
    expect(html.match(/class="theme"/g)).toHaveLength(3);
    const details = html.match(/<details><summary>4 GitHub items<\/summary>(.*?)<\/details>/s)?.[1];
    contains(details, "First", "Second", "Third", "&lt;Fourth&gt;");
    contains(details, "example/repo-0", "example/&lt;hostile-repo&gt;");
    contains(
      details,
      'href="https://github.com/example/repo-0/pull/1" target="_blank" rel="noopener"',
    );
    expect(details?.match(/PR opened/g)).toHaveLength(4);
    excludes(details, "javascript:", "<hostile-repo>", "<Fourth>");
  });

  it("keeps source warning banners bounded and escapes hostile data on every page", () => {
    const hostile = 'bad"><img src=x onerror=alert(1)>';
    const report = document();
    report.orgs = [hostile];
    report.sources.github = { ok: false, warnings: [hostile], stats: {} };
    report.sources.discord = { ok: true, stale: true, warnings: [hostile], stats: {} };
    const member = report.members[0]!;
    member.login = member.display = member.affiliation = hostile;
    member.areas = [hostile];
    member.github.repos = { [hostile]: 10 };
    member.discord.channels = { [hostile]: 10 };
    const summary = {
      source: "fallback" as const,
      generatedAtMs: report.generatedAtMs,
      globalSummary: hostile,
      highlights: [hostile],
      fingerprint: "fixture",
      warnings: [hostile, hostile],
    };
    const person: Person = { github: [hostile], display: hostile, affiliation: hostile };
    const days = [personDay(hostile, "2026-09-07", 10), personDay(hostile, "2026-09-05", 5)];
    const overview = home(
      { day: [day("2026-09-07")] },
      { ...homeOptions, orgs: [hostile], latest: { report, summary } },
    );
    const reportHtml = renderReportPage(ctx, report, summary, []);
    for (const html of [
      overview,
      reportHtml,
      renderPeoplePage(ctx, [person], days, "2026-09-07"),
      renderPersonPage(ctx, person, days),
    ]) {
      excludes(html, hostile, "<img src=x");
      expect(html).toContain("bad&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
      expect(html.match(/<script\b/g)).toHaveLength(1);
    }
    expect(overview.match(/<section class="oc-banner oc-banner-warning"/g)).toHaveLength(3);
    expect(reportHtml).toContain('data-maintainer-search="bad&quot;');
  });

  it("groups active, quiet, read-only and archived people with ranked activity buckets", () => {
    const people: Person[] = [
      { github: ["quiet"] },
      { github: ["reader"], roleGroup: "readonly" },
      { github: ["archived"], status: "archived" },
      { github: ["active"] },
    ];
    const days = [
      personDay("active", "2026-09-07", 20),
      personDay("quiet", "2026-09-07", 0),
      personDay("reader", "2026-09-07", 3),
      personDay("archived", "2026-09-07", 50),
    ];
    const html = renderPeoplePage(ctx, people, days, "2026-09-07");
    const grid = html.slice(html.indexOf('class="people-grid"'));
    expect(grid.indexOf("/people/active/")).toBeLessThan(grid.indexOf("/people/quiet/"));
    expect(grid.indexOf("/people/quiet/")).toBeLessThan(grid.indexOf("/people/reader/"));
    expect(grid.indexOf("/people/reader/")).toBeLessThan(grid.indexOf("/people/archived/"));
    contains(grid, "level-0", "level-4", "is-archived");
    expect(html).toContain("28 days");
  });

  it("keeps closed intraday snapshots visibly incomplete", () => {
    const report = document("day", "2026-09-06");
    report.status = "partial";
    report.generatedAtMs = report.period.untilMs - 3_600_000;
    const html = reportPage(report);
    contains(html, "Incomplete snapshot");
    contains(html, "The window has since closed, so these totals remain incomplete.");
    expect(html).not.toContain("data-day-countdown data-until=");
  });

  it("shades activity at the site bucket boundaries within the ranking window", () => {
    const totals = [0, 1, 4, 5, 14, 15, 39, 40];
    const levels = [0, 1, 1, 2, 2, 3, 3, 4];
    const days = totals.map((total, index) => ({
      ...personDay("alice", `2026-09-${String(index + 1).padStart(2, "0")}`, 0),
      githubTotal: total,
    }));
    days.push({ ...personDay("alice", "2026-07-01", 1000) });
    const html = renderPeoplePage(ctx, [{ github: ["alice"] }], days, "2026-09-08");
    for (const [index, level] of levels.entries()) {
      const key = `2026-09-${String(index + 1).padStart(2, "0")}`;
      expect(html).toContain(
        `class="day-dot level-${level}" title="${key}: ${totals[index]} events"`,
      );
    }
    contains(html, "118 events · 118 GitHub · 0 Discord", "7 out of 8 days active");
  });

  it("links retained calendar cells to daily reports and leaves missing chart days as gaps", () => {
    const html = renderPersonPage(ctx, { github: ["alice"], display: "Alice" }, [
      personDay("alice", "2026-09-07", 12),
      personDay("alice", "2026-09-05", 6),
    ]);
    expect(html).toMatch(/class="day-cell[^"\n]*"[^>]*href="\/reports\/day\/2026-09-07\//);
    expect(html).not.toContain('href="/reports/day/2026-09-06/');
    contains(html, "GitHub events · left axis", "Discord messages · right axis");
    contains(html, "Exact daily values");
    const paths = [...html.matchAll(/class="person-activity-line[^"]*" d="([^"]*)"/g)];
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path[1]?.match(/M/g)).toHaveLength(2);
    }
  });
});

it("keeps members' owned-session links in their own active or quiet section without changing counts", () => {
  const report = document();
  report.members[0]!.login = "ALIce";
  report.members.push(makeMember(1, { login: "bob", display: "Bob" }));
  report.members.push(makeMember(0, { login: "quiet", display: "Quiet member" }));
  const before = JSON.stringify(report);
  const work = new Map([
    ["quiet", sessions("quiet", "Quiet work")],
    ["alice", sessions("alice", "Alice work")],
  ]);
  const html = renderReportPage(ctx, report, null, [], work);
  const cards = [...html.matchAll(/<article class="person oc-card".*?<\/article>/g)];
  expect(cards).toHaveLength(2);
  contains(cards[0]?.[0], 'data-work-session-key="agent:main:alice-work"', "Alice work");
  expect(cards[1]?.[0]).not.toContain("person-work-sessions");
  expect(cards[0]?.[0]).not.toContain("Quiet work");
  expect(html.split("data-maintainer-quiet")[1]?.split("</li>")[0]).toContain("Quiet work");
  contains(html, 'data-work-session-key="agent:main:quiet-work"');
  contains(html, "Visible to you now, not activity from this report period.");
  expect(JSON.stringify(report)).toBe(before);
});
