import { boundReportDocument } from "./aggregate.js";
import type { TeamReportsConfig, resolveTeamReportsConfig } from "./config.js";
import { renderMarkdown } from "./render/markdown.js";
import { buildRoster } from "./roster.js";
import { createDiscordSource } from "./sources/discord/index.js";
import { createGithubSource } from "./sources/github/index.js";
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
  reuseCollectedDays?: boolean;
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
  const rejectedDays: PeriodDescriptor[] = [];
  for (const period of params.periods) {
    runtime.signal.throwIfAborted();
    // runPeriods orders days before rollups. A rejected acquisition must also
    // preserve its parents during this generation, even if an older day exists.
    if (
      period.period !== "day" &&
      rejectedDays.some((day) => day.sinceMs < period.untilMs && day.untilMs > period.sinceMs)
    ) {
      continue;
    }
    const previous = await store.getPeriodDocument(period.period, period.key);
    runtime.signal.throwIfAborted();
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
      runtime.signal.throwIfAborted();
      const github = await untilAborted(
        sources.github.collect(resolved.github, window, roster, async (entries) => {
          runtime.signal.throwIfAborted();
          await store.appendActivity({ source: "github", entries });
        }),
        runtime.signal,
      );
      runtime.signal.throwIfAborted();
      const discord =
        resolved.discord && sources.discord
          ? await untilAborted(
              sources.discord.collect(resolved.discord, window, roster, async (entries) => {
                runtime.signal.throwIfAborted();
                await store.appendActivity({ source: "discord", entries });
              }),
              runtime.signal,
            )
          : undefined;
      runtime.signal.throwIfAborted();
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
      runtime.signal.throwIfAborted();
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
