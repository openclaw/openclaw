import { boundReportDocument } from "./aggregate.js";
import type { TeamReportsConfig, resolveTeamReportsConfig } from "./config.js";
import { renderMarkdown } from "./render/markdown.js";
import { buildRoster } from "./roster.js";
import { createDiscordSource } from "./sources/discord/index.js";
import { createGithubSource } from "./sources/github/index.js";
import type { TeamReportsStore } from "./store.js";
import { generateSummaries, type SummaryLlm } from "./summaries.js";
import type { Person, PeriodDescriptor, SourceRuntime, SourceStatus } from "./types.js";

export type ResolvedTeamReportsConfig = Awaited<ReturnType<typeof resolveTeamReportsConfig>>;
export async function generateReportPeriods(params: {
  config: TeamReportsConfig;
  resolved: ResolvedTeamReportsConfig;
  store: TeamReportsStore;
  llm: SummaryLlm;
  periods: PeriodDescriptor[];
  reuseCollectedDays?: boolean;
  runtime: SourceRuntime;
  onRoster: (people: Person[]) => void;
}): Promise<Record<string, SourceStatus>> {
  const { config, resolved, store, runtime } = params;
  const sources = {
    github: createGithubSource(runtime),
    discord: resolved.discord ? createDiscordSource(runtime) : undefined,
  };
  const loaded = await sources.github.loadRoster(resolved.github);
  if (!loaded.status.ok) {
    throw new Error("GitHub roster unavailable; check token access and configured teams");
  }
  const roster = buildRoster(resolved.people, loaded.people);
  params.onRoster([...new Set(roster.byLogin.values())]);
  const statuses: Record<string, SourceStatus> = {};
  const rejectedDays: PeriodDescriptor[] = [];
  for (const period of params.periods) {
    // runPeriods orders days before rollups. A rejected acquisition must also
    // preserve its parents during this generation, even if an older day exists.
    if (
      period.period !== "day" &&
      rejectedDays.some((day) => day.sinceMs < period.untilMs && day.untilMs > period.sinceMs)
    ) {
      continue;
    }
    const previous = await store.getPeriodDocument(period.period, period.key);
    const accepted = previous?.report;
    if (
      params.reuseCollectedDays &&
      period.period === "day" &&
      accepted &&
      accepted.status === "closed" &&
      Object.values(accepted.sources).every((source) => source.ok) &&
      accepted.orgs.join("\0") === [...new Set(resolved.github.orgs)].toSorted().join("\0")
    ) {
      statuses[`day/${period.key}/github`] = accepted.sources.github;
      if (accepted.sources.discord) {
        statuses[`day/${period.key}/discord`] = accepted.sources.discord;
      }
      continue;
    }
    let report;
    if (period.period === "day") {
      const cutoffMs = Date.now();
      const window = { sinceMs: period.sinceMs, untilMs: Math.min(cutoffMs, period.untilMs) };
      await store.resetActivity();
      const github = await sources.github.collect(
        resolved.github,
        window,
        roster,
        async (entries) => {
          await store.appendActivity({ source: "github", entries });
        },
      );
      const discord =
        resolved.discord && sources.discord
          ? await sources.discord.collect(resolved.discord, window, async (entries) => {
              await store.appendActivity({ source: "discord", entries });
            })
          : undefined;
      const githubStatus: SourceStatus = {
        ...github,
        warnings: [...new Set([...loaded.status.warnings, ...github.warnings])],
        stale: loaded.status.stale || github.stale,
      };
      report = await store.aggregateActivity({
        period,
        nowMs: cutoffMs,
        orgs: resolved.github.orgs,
        roster,
        githubStatus,
        discordStatus: discord,
        ignoreCommentPatterns: resolved.github.ignoreCommentPatterns,
        discordConfig: resolved.discord,
      });
      await store.resetActivity();
      report.generatedAtMs = Date.now();
    } else {
      report = await store.aggregatePeriod({
        period,
        nowMs: Date.now(),
        roster,
        orgs: resolved.github.orgs,
      });
    }
    statuses[`${period.period}/${period.key}/github`] = report.sources.github;
    if (report.sources.discord) {
      statuses[`${period.period}/${period.key}/discord`] = report.sources.discord;
    }
    // Failed recollection is diagnostic evidence, not a replacement activity
    // snapshot. Keep accepted counts/prose; the run still records these failures.
    if (period.period === "day" && Object.values(report.sources).some((source) => !source.ok)) {
      rejectedDays.push(period);
      continue;
    }
    // Publish deterministic text before making the optional model call.
    for (const options of [
      { enabled: false },
      ...(config.summaries.enabled ? [config.summaries] : []),
    ]) {
      const summarized = await generateSummaries({
        report,
        options,
        llm: params.llm,
        logger: runtime.logger,
        previous:
          options.enabled && previous?.summary
            ? { report: previous.report, summary: previous.summary }
            : undefined,
      });
      const bounded = boundReportDocument(summarized.report);
      await store.upsertPeriod({
        report: bounded,
        summary: summarized.summary,
        markdown: renderMarkdown(bounded, summarized.summary),
      });
    }
  }
  return statuses;
}
