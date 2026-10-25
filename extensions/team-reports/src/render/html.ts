import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { GITHUB_ITEM_KINDS } from "../github-item-kinds.js";
import { DAY_MS } from "../periods.js";
import type { TeamReportsHealth } from "../scheduler.js";
import type { PeriodListEntry } from "../store.js";
import type {
  GithubCounts,
  Period,
  PersonReport,
  ReportDocument,
  SummaryDocument,
} from "../types.js";
import type { PersonWorkSessions, WorkSessions } from "../work-sessions.js";
import { deltaMarkup, sparklineSvg, splitMarkup } from "./charts.js";
import {
  affiliation,
  banner,
  date,
  externalLink,
  formatWindow,
  href,
  isOpen,
  markdownBlocks,
  openPeriodStatus,
  type PageContext,
  periodTitle,
  relativeTime,
  sectionHeading,
  shell,
  sourceBanners,
} from "./page.js";
import { memberSummary, metric, renderAvatar } from "./shared.js";
import { renderPersonWorkSessions, renderWorkSessionsPreview } from "./work-sessions.js";

export { renderPeoplePage, renderPersonPage } from "./people.js";
export type { PageContext } from "./page.js";
export type PeriodIndex = Record<Period, PeriodListEntry[]>;
const PERIODS: Period[] = ["day", "week", "month"];
const SERIES_LENGTH = { day: 28, week: 12, month: 6 };
const combined = (entry: PeriodListEntry) => entry.githubTotal + entry.discordMessages;
const number = (value: number) => value.toLocaleString("en-US");

function completenessBadge(entry: PeriodListEntry): string {
  if (entry.status !== "partial") {
    return "";
  }
  if (Date.now() >= entry.untilMs) {
    return '<span class="oc-badge oc-badge-warning partial-report-badge">Incomplete</span>';
  }
  return entry.period === "day" && isOpen(entry) && entry.generatedAtMs < entry.untilMs
    ? '<span class="oc-badge oc-badge-info partial-report-badge">Intraday</span>'
    : "";
}

function quickTrend(index: PeriodIndex, entry: PeriodListEntry): string {
  const ascending = index[entry.period]
    .filter((candidate) => candidate.key <= entry.key)
    .toSorted((a, b) => a.key.localeCompare(b.key));
  const values = ascending.slice(-SERIES_LENGTH[entry.period]).map(combined);
  const previous = ascending.at(-2);
  let comparison = previous ? combined(previous) : undefined;
  let label = `prev ${entry.period}`;
  if (previous && entry.period !== "day" && isOpen(entry) && entry.generatedAtMs < entry.untilMs) {
    // Compare an aggregate's own snapshot against equally many prior stored days.
    const elapsedDays = Math.max(1, Math.ceil((entry.generatedAtMs - entry.sinceMs) / DAY_MS));
    const priorDays = index.day
      .filter((day) => day.sinceMs >= previous.sinceMs && day.sinceMs < previous.untilMs)
      .toSorted((a, b) => a.key.localeCompare(b.key))
      .slice(0, elapsedDays);
    if (priorDays.length === elapsedDays) {
      comparison = priorDays.reduce((sum, day) => sum + combined(day), 0);
      label += " to date";
    }
  }
  return `<span class="quick-trend">${deltaMarkup(combined(entry), comparison, label)}${sparklineSvg(values, `Combined activity, last ${values.length} ${entry.period}s`)}</span>`;
}
function quickCard(ctx: PageContext, index: PeriodIndex, period: Period): string {
  const entry = index[period][0];
  if (!entry) {
    return `<section class="quick-card oc-card"><span class="oc-eyebrow">${period}</span><span class="quick-title">No ${period} reports yet</span><p class="oc-empty">Generate a report to see activity.</p></section>`;
  }
  const open = isOpen(entry);
  return `<a class="quick-card oc-card oc-card-interactive${entry.status === "partial" ? " partial" : ""}" href="${escapeHtml(href(ctx.basePath, period, entry.key))}"><span class="oc-eyebrow">${open && period === "day" ? "today" : period}</span><span class="quick-title">${escapeHtml(periodTitle(entry))} ${completenessBadge(entry)}</span><span class="quick-meta">${escapeHtml(formatWindow(entry))}<br>${entry.activeMembers}/${entry.memberCount} active · ${number(entry.githubTotal)} GitHub · ${number(entry.discordMessages)} Discord</span>${openPeriodStatus(ctx, entry)}${quickTrend(index, entry)}</a>`;
}
function history(ctx: PageContext, entries: PeriodListEntry[], period: Period): string {
  const visible = period === "day" ? 7 : 12;
  const slots = period === "month" ? 6 : 12;
  const ascending = entries.toSorted((a, b) => a.key.localeCompare(b.key));
  const rows = entries
    .map((entry, index) => {
      const position = ascending.findIndex((candidate) => candidate.key === entry.key);
      const window = ascending.slice(Math.max(0, position - slots + 1), position + 1);
      const values = [...Array<number>(slots - window.length).fill(0), ...window.map(combined)];
      const trend =
        window.length >= 2 ? sparklineSvg(values, `Combined activity through ${entry.key}`) : "";
      const subline =
        period === "day"
          ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
              entry.sinceMs,
            )
          : formatWindow(entry);
      return `<a class="row" href="${escapeHtml(href(ctx.basePath, period, entry.key))}"${index >= visible ? " data-extra hidden" : ""}><span><span class="row-title-line"><span class="title">${escapeHtml(periodTitle(entry))}</span>${completenessBadge(entry)}</span><br><span class="date">${escapeHtml(subline)}</span></span><span class="row-trend" aria-hidden="true">${trend}</span><span class="stats"><strong>${entry.activeMembers}/${entry.memberCount}</strong> active<br>${number(entry.githubTotal)} GitHub / ${number(entry.discordMessages)} Discord</span></a>`;
    })
    .join("");
  return `<section class="oc-section" id="${period}"><div class="oc-section-header"><div><div class="oc-eyebrow">${period}</div><h2>${period[0]?.toUpperCase()}${period.slice(1)} History</h2></div>${entries.length > visible ? `<button class="toggle oc-action oc-action-ghost js-only" type="button" data-toggle="${period}" aria-expanded="false">Show all ${entries.length}</button>` : ""}</div><div class="list" data-list="${period}">${rows || `<p class="oc-empty">No ${period} reports yet.</p>`}</div></section>`;
}
function homeMetric(label: string, value: string | number): string {
  return `<div class="oc-summary-metric"><div class="oc-summary-metric-copy"><small>${escapeHtml(label)}</small><strong>${value}</strong></div></div>`;
}
export function renderIndexPage(
  ctx: PageContext,
  index: PeriodIndex,
  options: {
    orgs: string[];
    latest?: { report: ReportDocument; summary: SummaryDocument | null };
    health: TeamReportsHealth;
    workSessions?: WorkSessions;
  },
): string {
  const days = index.day.toSorted((a, b) => a.key.localeCompare(b.key));
  const latestDay = index.day[0];
  const generated = Math.max(
    0,
    ...PERIODS.flatMap((period) => index[period].map((entry) => entry.generatedAtMs)),
  );
  const orgs = options.orgs.join(", ");
  const dateline =
    days.length >= 2
      ? `<section class="home-dateline" aria-label="Activity dateline"><div class="oc-eyebrow">dateline</div>${sparklineSvg(days.map(combined), `Combined GitHub and Discord activity across ${days.length} report days`, true)}<div class="home-dateline-scale"><span>${escapeHtml(days[0]?.key ?? "")}</span><span>${days.length} report days</span><span>${escapeHtml(days.at(-1)?.key ?? "")}</span></div></section>`
      : "";
  const open = PERIODS.filter((period) => index[period][0] && isOpen(index[period][0]));
  const openBanner = open.length
    ? banner(
        "info",
        `<strong class="oc-banner-title">Open reporting windows</strong><p>The current UTC ${open.join(", ")} ${open.length === 1 ? "remains" : "remain"} open. ${open.length === 1 ? "Its total is a snapshot" : "Their totals are snapshots"} and update as new activity arrives.</p>`,
      )
    : "";
  const health = options.health;
  const lastRun = health.lastRun
    ? `<span class="oc-badge oc-badge-${health.lastRun.status === "ok" ? "success" : "warning"}">${health.lastRun.status}</span> ${relativeTime(ctx, health.lastRun.finishedAtMs)}`
    : "—";
  return shell(
    ctx,
    "Overview",
    `<div class="home-grid" aria-label="Report overview"><section class="oc-brand-banner home-banner" data-asset="crab" data-anchor="top" data-effect="fade" data-size="hero"><div class="oc-brand-banner-art" aria-hidden="true"><img src="${escapeHtml(ctx.basePath)}/assets/crab.avif" alt="" draggable="false"></div><div class="oc-brand-banner-content"><p class="oc-eyebrow">${escapeHtml(orgs)} · team</p><h1>Team Reports</h1><p>Daily, weekly, and monthly GitHub and Discord activity for ${escapeHtml(orgs)}. Access is enforced by the Gateway; history is stored by the plugin.</p></div><div class="home-banner-stamp">generated ${generated ? relativeTime(ctx, generated) : "—"}</div></section>${options.workSessions ? renderWorkSessionsPreview(ctx, options.workSessions) : ""}${dateline}${openBanner}${options.latest ? sourceBanners(options.latest.report, options.latest.summary) : ""}${PERIODS.map((period) => quickCard(ctx, index, period)).join("")}<section class="home-card people-teaser oc-card"><div class="home-card-top"><div><div class="oc-eyebrow">people</div><h2>People Archive</h2><p>Activity timelines and repository history by team member.</p></div><div class="home-actions-row"><a class="panel-link oc-action" href="${escapeHtml(ctx.basePath)}/people/">Open people archive <span aria-hidden="true">→</span></a></div></div><div class="oc-summary-strip">${homeMetric("People", latestDay?.memberCount ?? 0)}${homeMetric("Active today", latestDay?.activeMembers ?? 0)}${homeMetric("Report days", days.length)}</div></section><section class="home-card generation-panel oc-card"><div class="home-card-top"><div><div class="oc-eyebrow">runs</div><h2>Generation Status</h2><p>Scheduler and source health.</p></div><div class="home-actions-row"><a class="panel-link oc-action" href="${escapeHtml(ctx.basePath)}/status">Open status JSON <span aria-hidden="true">→</span></a></div></div><div class="oc-summary-strip">${homeMetric("Last run", lastRun)}${homeMetric("Next due", health.nextDueMs === undefined ? "—" : relativeTime(ctx, health.nextDueMs))}${homeMetric("Source warnings", health.warnings)}</div></section></div><div class="grid">${PERIODS.map((period) => history(ctx, index[period], period)).join("")}</div>`,
    "home",
  );
}

function activitySegments(github: GithubCounts, discord: number) {
  const prs = github.prsOpened + github.prsMerged + github.prsClosed;
  const issues = github.issuesOpened + github.issuesClosed;
  const comments = github.issueComments + github.reviewComments;
  return [
    { label: "Commits", value: github.commits, tone: "primary" },
    { label: "PRs", value: prs, tone: "secondary" },
    { label: "Issues", value: issues, tone: "tertiary" },
    { label: "Comments", value: comments, tone: "quaternary" },
    { label: "GHSAs", value: github.securityAdvisories, tone: "error" },
    {
      label: "Other GitHub",
      value: Math.max(
        0,
        github.total - github.commits - prs - issues - comments - github.securityAdvisories,
      ),
      tone: "neutral",
    },
    { label: "Discord", value: discord, tone: "muted" },
  ].filter((segment) => segment.value > 0);
}

function distribution(ctx: PageContext, members: PersonReport[]): string {
  const ranked = members
    .filter((member) => member.github.total + member.discord.total > 0)
    .toSorted(
      (a, b) =>
        b.github.total + b.discord.total - a.github.total - a.discord.total ||
        a.login.localeCompare(b.login),
    );
  const total = ranked.reduce((sum, member) => sum + member.github.total + member.discord.total, 0);
  if (total === 0) {
    return '<div class="oc-empty"><p class="oc-empty-description">No member activity recorded in this window.</p></div>';
  }
  const row = (member: PersonReport) => {
    const value = member.github.total + member.discord.total;
    const segments = activitySegments(member.github, member.discord.total);
    let offset = 0;
    const rectangles = segments
      .map((segment) => {
        const width = (segment.value / total) * 100;
        const rect = `<rect class="distribution-segment oc-split-${segment.tone}" x="${offset.toFixed(3)}" y="0" width="${width.toFixed(3)}" height="8"><title>${escapeHtml(segment.label)}: ${segment.value}</title></rect>`;
        offset += width;
        return rect;
      })
      .join("");
    const breakdown = segments
      .map(
        (segment) =>
          `<span class="distribution-breakdown-item"><span class="distribution-breakdown-key oc-split-${segment.tone}" aria-hidden="true"></span>${escapeHtml(segment.label)} ${segment.value}</span>`,
      )
      .join("");
    return `<li><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}" aria-label="${escapeHtml(`@${member.login}: ${value} activities, ${Math.round((value / total) * 100)}%`)}"><span class="distribution-label"><span class="distribution-label-primary">@${escapeHtml(member.login)}</span><span class="distribution-label-detail">${escapeHtml(member.display)}</span></span><svg class="distribution-track" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(`Activity types for @${member.login}`)}">${rectangles}</svg><strong class="distribution-total">${value}</strong><span class="distribution-share">${Math.round((value / total) * 100)}%</span><span class="distribution-breakdown">${breakdown}</span></a></li>`;
  };
  return `<div class="ranked-distribution" aria-label="Activity by Member"><ol class="ranked-distribution-list">${ranked.slice(0, 12).map(row).join("")}</ol>${ranked.length > 12 ? `<details class="distribution-more"><summary>Show remaining ${ranked.length - 12}</summary><ol class="ranked-distribution-list" start="13">${ranked.slice(12).map(row).join("")}</ol></details>` : ""}</div>`;
}

function roleBadges(member: PersonReport): string {
  const role = member.roleLabel ?? member.roleGroup;
  return `${role ? `<span class="oc-badge oc-badge-${member.roleGroup === "readonly" ? "neutral" : "info"}">${escapeHtml(role)}</span>` : ""}${member.access.map((access) => `<span class="oc-badge oc-badge-neutral">${escapeHtml(access)}</span>`).join("")}`;
}

function searchText(member: PersonReport): string {
  return escapeHtml(
    [member.login, member.display, ...member.aliases, member.affiliation, ...member.areas]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  );
}

export function renderReportPage(
  ctx: PageContext,
  report: ReportDocument,
  summary: SummaryDocument | null,
  reportHistory: PeriodListEntry[] = [],
  workSessions: ReadonlyMap<string, PersonWorkSessions> = new Map(),
): string {
  const entry = { ...report.period, status: report.status, generatedAtMs: report.generatedAtMs };
  const open = isOpen(entry);
  const period = report.period.period;
  const path = href(ctx.basePath, period, report.period.key);
  const incomplete =
    open || (report.status === "partial" && report.generatedAtMs < report.period.untilMs);
  const partialBanner = incomplete
    ? banner(
        "info",
        `<strong class="oc-banner-title">Partial report</strong><span class="oc-badge oc-badge-info partial-report-badge">Incomplete snapshot</span><p>${open ? `This UTC ${period} is still in progress.` : `This UTC ${period} was still in progress when this snapshot was generated.`} Totals include activity collected through ${relativeTime(ctx, report.generatedAtMs)}. ${open ? "Activity may increase before the window closes." : "The window has since closed, so these totals remain incomplete."}</p>`,
      )
    : "";
  const github = report.totals.github;
  const prior = reportHistory
    .filter((row) => row.period === period && row.sinceMs < report.period.sinceMs)
    .toSorted((a, b) => a.sinceMs - b.sinceMs)
    .slice(-({ day: 28, week: 12, month: 6 }[period] - 1));
  const trend = (
    field: "activeMembers" | "githubTotal" | "discordMessages" | "prsOpened" | "securityAdvisories",
    value: number,
    label: string,
    badUp = false,
  ) => {
    const values = [...prior.map((row) => row[field]), value];
    return `<small>${deltaMarkup(value, prior.at(-1)?.[field], `prev ${period}${open ? " (in progress)" : ""}`, badUp)}</small>${sparklineSvg(values, `${label} by ${period}`)}`;
  };
  const active = report.members.filter((member) => member.github.total + member.discord.total > 0);
  const quiet = report.members.filter((member) => member.github.total + member.discord.total === 0);
  function personRow(member: PersonReport): string {
    const memberWorkSessions = workSessions.get(member.login.toLowerCase());
    const top = (values: Record<string, number>, limit: number) =>
      Object.entries(values)
        .toSorted(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
        .slice(0, limit);
    const chips = [
      ...top(member.github.repos, 4).map(([repo, count]) => `${repo}: ${count}`),
      ...top(member.discord.channels, 3).map(([channel, count]) => `#${channel}: ${count}`),
      ...member.areas.map((area) => `owns: ${area}`),
    ]
      .map((text) => `<span class="oc-badge oc-badge-neutral">${escapeHtml(text)}</span>`)
      .join("");
    const themes = member.github.items
      .slice(0, 3)
      .map(
        (item) =>
          `<div class="theme"><span class="theme-kind">${GITHUB_ITEM_KINDS[item.kind].label}</span> ${externalLink(item.url, item.title)}</div>`,
      )
      .join("");
    const counts: Array<[string, number]> = [
      ["GitHub", member.github.total],
      ["Commits", member.github.commits],
      ["GHSAs", member.github.securityAdvisories],
      ["PRs", member.github.prsOpened + member.github.prsMerged + member.github.prsClosed],
      ["Issues", member.github.issuesOpened + member.github.issuesClosed],
      ["Comments", member.github.issueComments + member.github.reviewComments],
      ["Discord", member.discord.total],
    ];
    const excerpts = member.discord.excerpts.length
      ? `<details><summary>Discord excerpts</summary>${member.discord.excerpts.map((excerpt) => `<blockquote><small>#${escapeHtml(excerpt.channel)} · ${escapeHtml(date(excerpt.atMs, ctx.displayTimezone))}</small><br>${escapeHtml(excerpt.excerpt)}</blockquote>`).join("")}</details>`
      : "";
    const items = member.github.items.length
      ? `<details><summary>${member.github.items.length} GitHub items</summary><ul class="oc-resource-list">${member.github.items.map((item) => `<li class="oc-resource-list-item resource-row"><span class="theme-kind">${GITHUB_ITEM_KINDS[item.kind].label} · ${escapeHtml(item.repo)}</span>${externalLink(item.url, item.title)}</li>`).join("")}</ul></details>`
      : "";
    return `<article class="person oc-card" data-maintainer-card data-maintainer-search="${searchText(member)}"><div class="person-title"><div class="person-heading">${renderAvatar(member.login, member.display, "md")}<div><a class="handle" href="${escapeHtml(href(ctx.basePath, "people", member.login))}">@${escapeHtml(member.login)}</a><div class="person-name">${escapeHtml(member.display)}</div>${member.aliases.length ? `<div class="alias-line">${member.aliases.map((alias) => `@${escapeHtml(alias)}`).join(" · ")}</div>` : ""}</div></div>${affiliation(member)}<div class="role-line">${roleBadges(member)}</div></div><div class="person-body"><div class="chips">${chips}</div><p class="focus">${escapeHtml(memberSummary(member))}</p>${themes}${items}${excerpts}${memberWorkSessions ? renderPersonWorkSessions(ctx, member.login, memberWorkSessions) : ""}</div><div class="person-numbers">${counts.map(([label, count]) => `<div class="number-line"><span>${label}</span><strong>${count}</strong></div>`).join("")}</div></article>`;
  }
  const roleCounts = ["core", "volunteer", "readonly"].map(
    (role) => active.filter((member) => member.roleGroup === role).length,
  );
  const repositories =
    Number(report.sources.github.stats.reposScanned) || Object.keys(github.repos).length;
  const channels =
    Number(report.sources.discord?.stats.channelsScanned) ||
    Object.keys(report.totals.discord.channels).length;
  const totals = [
    metric(
      "Active",
      `${report.activeMembers}/${report.memberCount}`,
      roleCounts.some((count) => count > 0)
        ? `${roleCounts[0]} Core / ${roleCounts[1]} Community / ${roleCounts[2]} Read-only`
        : "members with activity",
      trend("activeMembers", report.activeMembers, "Active members"),
    ),
    metric("GitHub", github.total, "events", trend("githubTotal", github.total, "GitHub events")),
    metric(
      "Discord",
      report.totals.discord.messages,
      "messages",
      trend("discordMessages", report.totals.discord.messages, "Discord messages"),
    ),
    metric(
      "PRs Opened",
      github.prsOpened,
      `${github.prsMerged} merged`,
      trend("prsOpened", github.prsOpened, "PRs opened"),
    ),
    metric(
      "Security",
      github.securityAdvisories,
      "advisories",
      trend("securityAdvisories", github.securityAdvisories, "Security advisories", true),
    ),
    metric(
      "Repos",
      Object.entries(github.repos).filter(([, count]) => count > 0).length,
      "active repositories",
    ),
  ].join("");
  const mix = [
    metric("Commits", github.commits),
    metric("GHSAs", github.securityAdvisories),
    metric("Issue/PR comments", github.issueComments),
    metric("PR review comments", github.reviewComments),
    metric("Discord messages", report.totals.discord.messages),
  ].join("");
  const quietBlock = quiet.length
    ? `<div class="quiet-maintainers"><div class="quiet-title"><h3>No visible activity</h3><span class="small">${quiet.length} members</span></div><ul class="quiet-list">${quiet.map((member) => `<li data-maintainer-quiet data-maintainer-search="${searchText(member)}"><a href="${escapeHtml(href(ctx.basePath, "people", member.login))}">@${escapeHtml(member.login)} — ${escapeHtml(member.display)}${member.affiliation ? ` — ${escapeHtml(member.affiliation)}` : ""}</a>${workSessions.has(member.login.toLowerCase()) ? renderPersonWorkSessions(ctx, member.login, workSessions.get(member.login.toLowerCase())!) : ""}</li>`).join("")}</ul></div>`
    : "";
  const other = report.otherActors.length
    ? `<section class="oc-section">${sectionHeading("Other GitHub actors", "Outside the roster")}<ul class="oc-resource-list">${report.otherActors.map((actor) => `<li class="oc-resource-list-item resource-row"><span class="person-identity">${renderAvatar(actor.login, actor.login, "xs")}<span>@${escapeHtml(actor.login)}</span></span><span>${actor.github.total} GitHub events</span></li>`).join("")}</ul></section>`
    : "";
  const unmatched = report.unmatchedDiscord.length
    ? `<section class="oc-section">${sectionHeading("Unmatched Discord authors", "Coverage")}<p class="section-note">These messages count toward Discord totals. No message content is included.</p><ul class="oc-resource-list">${report.unmatchedDiscord.map((actor) => `<li class="oc-resource-list-item resource-row"><span>${escapeHtml(actor.authorId)}</span><span>${actor.messages} messages</span></li>`).join("")}</ul></section>`
    : "";
  // Fallback summaries restate their bullets as highlights; only list what the overview text lacks.
  const highlights =
    summary?.highlights.filter((highlight) => !summary.globalSummary.includes(highlight)) ?? [];
  return shell(
    ctx,
    periodTitle(report.period),
    `<header><div><h1>${escapeHtml(periodTitle(report.period))}</h1><p class="subtitle">Evidence report across ${repositories} GitHub repositories and ${channels} Discord channels for ${escapeHtml(report.orgs.join(", "))}. Roster: ${report.memberCount} people.</p><div class="actions"><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}report.md">Markdown</a><a class="oc-action oc-action-ghost" href="${escapeHtml(path)}data.json">JSON</a></div></div><div class="oc-card oc-summary-metric"><span class="oc-summary-metric-copy"><small>Window</small><strong>${escapeHtml(formatWindow(report.period))}</strong><small>${open ? openPeriodStatus(ctx, entry) : `As of ${relativeTime(ctx, report.generatedAtMs)}`}</small></span></div></header>${partialBanner}${sourceBanners(report, summary)}<section class="oc-summary-strip" aria-label="Report totals">${totals}</section><section class="oc-section">${sectionHeading("Global Summary", "Overview", summary?.source === "model" ? "Model summary" : "Summary without a model")}<div class="summary-markdown">${summary ? `${markdownBlocks(summary.globalSummary)}${highlights.length ? `<ul>${highlights.map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul>` : ""}` : `<p>${report.activeMembers} of ${report.memberCount} members recorded ${github.total} GitHub events and ${report.totals.discord.messages} Discord messages in this window.</p>`}</div></section><section class="oc-section">${sectionHeading("Activity Mix", "Hard Numbers")}<div class="oc-summary-strip">${mix}</div><div class="mix-split">${splitMarkup(activitySegments(github, report.totals.discord.messages))}</div><div class="maintainer-distribution"><div class="distribution-heading"><div><div class="oc-eyebrow">Mapped activity</div><h3>Activity by Member</h3></div><p class="section-note">Bar length shows share; colors show activity type</p></div>${distribution(ctx, report.members)}</div></section><section class="oc-section collection-section" data-maintainer-filter-root><div class="oc-section-header people-head"><div><div class="oc-eyebrow">Members</div><h2>Members</h2></div><div class="people-tools js-only"><input class="person-filter oc-input" type="search" autocomplete="off" placeholder="Filter by name or handle" aria-label="Filter members by name, handle, or alias" data-maintainer-filter><div class="filter-status" data-maintainer-filter-status aria-live="polite">showing ${active.length} of ${active.length} active</div></div></div><div class="people">${active.map(personRow).join("") || '<div class="oc-empty"><p class="oc-empty-description">No visible GitHub or Discord activity in this window.</p></div>'}</div><div class="oc-empty" hidden data-maintainer-filter-empty><p class="oc-empty-description">No matching member in this report.</p></div>${quietBlock}</section>${other}${unmatched}`,
    "report",
  );
}
