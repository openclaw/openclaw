import { aggregateDay, aggregateDays, boundReportDocument } from "./aggregate.js";
import type { TeamReportsConfig, resolveTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { buildRoster } from "./roster.js";
import { createDiscordSource, createGithubSource } from "./sources/index.js";
import type { TeamReportsStore } from "./store.js";
import { generateSummaries, type SummaryLlm } from "./summaries.js";
import type {
  DiscordSource,
  GithubSource,
  Person,
  PeriodDescriptor,
  SourceRuntime,
  SourceStatus,
} from "./types.js";

export type ResolvedTeamReportsConfig = Awaited<ReturnType<typeof resolveTeamReportsConfig>>;
export type ReportSourceFactory = (runtime: SourceRuntime) => {
  github: GithubSource;
  discord?: DiscordSource;
};

export function createReportSources(runtime: SourceRuntime, discordEnabled: boolean) {
  return {
    github: createGithubSource(runtime),
    discord: discordEnabled ? createDiscordSource(runtime) : undefined,
  };
}

export function runPeriods(
  config: TeamReportsConfig,
  days: PeriodDescriptor[],
): PeriodDescriptor[] {
  const periods = new Map(days.map((day) => [`day/${day.key}`, day]));
  // Also close the week/month containing yesterday when the calendar rolls over.
  for (const day of days) {
    for (const period of ["week", "month"] as const) {
      if (period === "week" ? config.schedule.weekly : config.schedule.monthly) {
        const descriptor = describePeriod(period, day.sinceMs);
        periods.set(`${period}/${descriptor.key}`, descriptor);
      }
    }
  }
  return [...periods.values()];
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "Team Reports run aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function generateReportPeriods(params: {
  config: TeamReportsConfig;
  resolved: ResolvedTeamReportsConfig;
  store: TeamReportsStore;
  llm: SummaryLlm;
  periods: PeriodDescriptor[];
  runtime: SourceRuntime & { signal: AbortSignal };
  sources: ReportSourceFactory;
  onRoster: (people: Person[]) => void;
}): Promise<Record<string, SourceStatus>> {
  const { config, resolved, store, runtime } = params;
  const sources = params.sources(runtime);
  const loaded = await untilAborted(sources.github.loadRoster(resolved.github), runtime.signal);
  runtime.signal.throwIfAborted();
  if (!loaded.status.ok) {
    throw new Error("GitHub roster unavailable; check token access and configured teams");
  }
  const roster = buildRoster(resolved.people, loaded.people);
  params.onRoster([...new Set(roster.byLogin.values())]);
  const statuses: Record<string, SourceStatus> = {};
  for (const period of params.periods) {
    runtime.signal.throwIfAborted();
    const previous = await store.getPeriod(period.period, period.key);
    runtime.signal.throwIfAborted();
    let report;
    if (period.period === "day") {
      const cutoffMs = Date.now();
      const window = { sinceMs: period.sinceMs, untilMs: Math.min(cutoffMs, period.untilMs) };
      const github = await untilAborted(
        sources.github.collect(resolved.github, window, roster),
        runtime.signal,
      );
      runtime.signal.throwIfAborted();
      const discord =
        resolved.discord && sources.discord
          ? await untilAborted(
              sources.discord.collect(resolved.discord, window, roster),
              runtime.signal,
            )
          : undefined;
      runtime.signal.throwIfAborted();
      const githubStatus: SourceStatus = {
        ...github.status,
        warnings: [...new Set([...loaded.status.warnings, ...github.status.warnings])],
        stale: loaded.status.stale || github.status.stale,
      };
      report = aggregateDay({
        period,
        nowMs: cutoffMs,
        orgs: resolved.github.orgs,
        roster,
        items: github.items,
        messages: discord?.messages ?? [],
        githubStatus,
        discordStatus: discord?.status,
        ignoreCommentPatterns: resolved.github.ignoreCommentPatterns,
        discordConfig: resolved.discord,
      });
      report.generatedAtMs = Date.now();
    } else {
      report = aggregateDays({
        period,
        nowMs: Date.now(),
        days: await store.getDayReports(period.sinceMs, period.untilMs),
        roster,
        orgs: resolved.github.orgs,
      });
    }
    statuses[`${period.period}/${period.key}/github`] = report.sources.github;
    if (report.sources.discord) {
      statuses[`${period.period}/${period.key}/discord`] = report.sources.discord;
    }
    // Commit collected evidence before the model call, including deterministic text for readers.
    const fallback = await generateSummaries({
      report,
      options: { enabled: false },
      llm: params.llm,
      signal: runtime.signal,
    });
    runtime.signal.throwIfAborted();
    const boundedFallback = boundReportDocument(fallback.report);
    await store.upsertPeriod({
      report: boundedFallback,
      summary: fallback.summary,
      markdown: renderMarkdown(boundedFallback, fallback.summary),
    });
    runtime.signal.throwIfAborted();
    if (config.summaries.enabled) {
      const summarized = await untilAborted(
        generateSummaries({
          report,
          options: config.summaries,
          llm: params.llm,
          logger: runtime.logger,
          previous: previous?.summary
            ? { report: previous.report, summary: previous.summary }
            : undefined,
          signal: runtime.signal,
        }),
        runtime.signal,
      );
      runtime.signal.throwIfAborted();
      const bounded = boundReportDocument(summarized.report);
      await store.upsertPeriod({
        report: bounded,
        summary: summarized.summary,
        markdown: renderMarkdown(bounded, summarized.summary),
      });
    }
    runtime.signal.throwIfAborted();
  }
  return statuses;
}
