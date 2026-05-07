#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_REPOSITORY = "openclaw/openclaw";
const CI_WORKFLOW_ID = "ci.yml";
const GH_MAX_BUFFER = 32 * 1024 * 1024;

function parseTime(value) {
  if (!value || value === "0001-01-01T00:00:00Z") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsBetween(start, end) {
  return start !== null && end !== null ? Math.round((end - start) / 1000) : null;
}

function formatSeconds(value) {
  return value === null ? "" : `${value}s`;
}

function normalizeRun(run) {
  return {
    ...run,
    createdAt: run.createdAt ?? run.created_at,
    databaseId: run.databaseId ?? run.id,
    displayTitle: run.displayTitle ?? run.display_title,
    event: run.event,
    headSha: run.headSha ?? run.head_sha,
    runStartedAt: run.runStartedAt ?? run.run_started_at,
    status: run.status,
    conclusion: run.conclusion,
    updatedAt: run.updatedAt ?? run.updated_at,
  };
}

function normalizeJob(job) {
  return {
    ...job,
    completedAt: job.completedAt ?? job.completed_at,
    runnerName: job.runnerName ?? job.runner_name,
    startedAt: job.startedAt ?? job.started_at,
  };
}

function collectRunTimingContext(run) {
  const normalizedRun = normalizeRun(run);
  const created = parseTime(normalizedRun.createdAt);
  const runUpdated = parseTime(normalizedRun.updatedAt);
  const jobs = (normalizedRun.jobs ?? [])
    .map(normalizeJob)
    .filter((job) => !job.name?.startsWith("matrix."))
    .map((job) => {
      const started = parseTime(job.startedAt);
      const completed = parseTime(job.completedAt);
      return {
        conclusion: job.conclusion ?? "",
        durationSeconds: secondsBetween(started, completed),
        name: job.name,
        queueSeconds: secondsBetween(created, started),
        started,
        completed,
        status: job.status,
      };
    });

  const completedTimes = jobs.map((job) => job.completed).filter((completed) => completed !== null);
  const lastCompleted = completedTimes.length === 0 ? null : Math.max(...completedTimes);
  const updated =
    runUpdated !== null && lastCompleted !== null
      ? Math.max(runUpdated, lastCompleted)
      : (runUpdated ?? lastCompleted);

  return { created, jobs, run: normalizedRun, updated };
}

export function summarizeRunTimings(run, limit = 15) {
  const { created, jobs, run: normalizedRun, updated } = collectRunTimingContext(run);
  const byDuration = [...jobs]
    .filter((job) => job.durationSeconds !== null)
    .toSorted((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, limit);
  const byQueue = [...jobs]
    .filter((job) => job.queueSeconds !== null && (job.durationSeconds ?? 0) > 5)
    .toSorted((left, right) => right.queueSeconds - left.queueSeconds)
    .slice(0, limit);
  const badJobs = jobs.filter(
    (job) => job.conclusion && !["success", "skipped", "cancelled"].includes(job.conclusion),
  );

  return {
    byDuration,
    byQueue,
    conclusion: normalizedRun.conclusion ?? "",
    status: normalizedRun.status ?? "",
    wallSeconds: secondsBetween(created, updated),
    badJobs,
  };
}

export function selectLatestMainPushCiRun(runs, headSha = null) {
  const pushRuns = runs.map(normalizeRun).filter((run) => run.event === "push");
  if (headSha) {
    const matchingRun = pushRuns.find((run) => run.headSha === headSha);
    if (matchingRun) {
      return matchingRun;
    }
  }
  return pushRuns[0] ?? null;
}

function repositorySlug() {
  return process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
}

function ghApiJson(path) {
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: GH_MAX_BUFFER,
    }),
  );
}

function listMainCiRuns(limit) {
  const runs = [];
  const perPage = Math.max(1, Math.min(100, limit));
  for (let page = 1; runs.length < limit && page <= 10; page += 1) {
    const data = ghApiJson(
      `repos/${repositorySlug()}/actions/workflows/${CI_WORKFLOW_ID}/runs?branch=main&per_page=${perPage}&page=${page}&exclude_pull_requests=true`,
    );
    const pageRuns = (data.workflow_runs ?? []).map(normalizeRun);
    runs.push(...pageRuns);
    if (pageRuns.length < perPage) {
      break;
    }
  }
  return runs.slice(0, limit);
}

function getLatestCiRunId() {
  const runs = listMainCiRuns(1);
  const runId = runs[0]?.databaseId;
  if (!runId) {
    throw new Error("No CI runs found on main");
  }
  return String(runId);
}

function getRemoteMainSha() {
  const raw = execFileSync("git", ["ls-remote", "origin", "main"], { encoding: "utf8" }).trim();
  const [sha] = raw.split(/\s+/u);
  if (!sha) {
    throw new Error("Could not resolve origin/main");
  }
  return sha;
}

function getLatestMainPushCiRunId() {
  const headSha = getRemoteMainSha();
  const run = selectLatestMainPushCiRun(listMainCiRuns(40), headSha);
  if (!run?.databaseId) {
    throw new Error(`No push CI run found for origin/main ${headSha.slice(0, 10)}`);
  }
  return String(run.databaseId);
}

function listRecentSuccessfulCiRuns(limit) {
  return listMainCiRuns(Math.max(limit * 12, 100))
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .slice(0, limit);
}

function loadRun(runId) {
  const repository = repositorySlug();
  const run = normalizeRun(ghApiJson(`repos/${repository}/actions/runs/${runId}`));
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = ghApiJson(
      `repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
    );
    const pageJobs = data.jobs ?? [];
    jobs.push(...pageJobs.map(normalizeJob));
    if (pageJobs.length < 100) {
      break;
    }
  }
  return {
    ...run,
    createdAt: run.createdAt ?? run.runStartedAt,
    jobs,
  };
}

function summarizeJobs(run) {
  const { created, jobs, updated } = collectRunTimingContext(run);
  const completedJobs = jobs.filter((job) => job.started !== null && job.completed !== null);
  const successfulDurations = jobs
    .filter((job) => job.status === "completed" && job.conclusion === "success")
    .map((job) => job.durationSeconds)
    .filter((duration) => duration !== null);
  const firstStart = Math.min(...completedJobs.map((job) => job.started));
  const lastComplete = Math.max(...completedJobs.map((job) => job.completed));

  return {
    avgDurationSeconds:
      successfulDurations.length === 0
        ? null
        : Math.round(
            successfulDurations.reduce((sum, duration) => sum + duration, 0) /
              successfulDurations.length,
          ),
    executionWindowSeconds:
      Number.isFinite(firstStart) && Number.isFinite(lastComplete)
        ? secondsBetween(firstStart, lastComplete)
        : null,
    firstQueueSeconds: Number.isFinite(firstStart) ? secondsBetween(created, firstStart) : null,
    jobCount: successfulDurations.length,
    maxDurationSeconds: successfulDurations.length === 0 ? null : Math.max(...successfulDurations),
    p90DurationSeconds: percentile(successfulDurations, 0.9),
    p95DurationSeconds: percentile(successfulDurations, 0.95),
    wallSeconds: secondsBetween(created, updated),
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function printSection(title, jobs, metric) {
  console.log(title);
  for (const job of jobs) {
    console.log(
      `${String(job.name).padEnd(48)} ${formatSeconds(job[metric]).padStart(6)}  queue=${formatSeconds(job.queueSeconds).padStart(6)}  ${job.status}/${job.conclusion}`,
    );
  }
}

export function parseRunTimingArgs(args) {
  const recentIndex = args.indexOf("--recent");
  const limitIndex = args.indexOf("--limit");
  const ignoredArgIndexes = new Set();
  for (const [index, arg] of args.entries()) {
    if (arg === "--" || arg === "--latest-main") {
      ignoredArgIndexes.add(index);
    }
  }
  if (limitIndex !== -1) {
    ignoredArgIndexes.add(limitIndex);
    ignoredArgIndexes.add(limitIndex + 1);
  }
  if (recentIndex !== -1) {
    ignoredArgIndexes.add(recentIndex);
    ignoredArgIndexes.add(recentIndex + 1);
  }
  const limit =
    limitIndex === -1 ? 15 : Math.max(1, Number.parseInt(args[limitIndex + 1] ?? "", 10) || 15);
  const recentLimit =
    recentIndex === -1 ? null : Math.max(1, Number.parseInt(args[recentIndex + 1] ?? "", 10) || 10);
  return {
    explicitRunId: args.find((_arg, index) => !ignoredArgIndexes.has(index)),
    limit,
    recentLimit,
    useLatestMain: args.includes("--latest-main"),
  };
}

async function main() {
  const { explicitRunId, limit, recentLimit, useLatestMain } = parseRunTimingArgs(
    process.argv.slice(2),
  );
  if (recentLimit !== null) {
    const runs = listRecentSuccessfulCiRuns(recentLimit);
    if (runs.length === 0) {
      console.log("No recent successful main CI runs found in the latest 100 runs.");
      return;
    }
    for (const run of runs) {
      const summary = summarizeJobs(loadRun(run.databaseId));
      console.log(
        [
          `CI run ${run.databaseId}`,
          run.headSha.slice(0, 10),
          `wall=${formatSeconds(summary.wallSeconds)}`,
          `exec=${formatSeconds(summary.executionWindowSeconds)}`,
          `firstQueue=${formatSeconds(summary.firstQueueSeconds)}`,
          `jobs=${summary.jobCount}`,
          `avg=${formatSeconds(summary.avgDurationSeconds)}`,
          `p90=${formatSeconds(summary.p90DurationSeconds)}`,
          `p95=${formatSeconds(summary.p95DurationSeconds)}`,
          `max=${formatSeconds(summary.maxDurationSeconds)}`,
        ].join("  "),
      );
    }
    return;
  }
  const runId = explicitRunId ?? (useLatestMain ? getLatestMainPushCiRunId() : getLatestCiRunId());
  const summary = summarizeRunTimings(loadRun(runId), limit);

  console.log(
    `CI run ${runId}: ${summary.status}/${summary.conclusion} wall=${formatSeconds(summary.wallSeconds)}`,
  );
  printSection("\nSlowest jobs", summary.byDuration, "durationSeconds");
  printSection("\nLongest queues", summary.byQueue, "queueSeconds");
  if (summary.badJobs.length > 0) {
    console.log("\nFailed jobs");
    for (const job of summary.badJobs) {
      console.log(`${job.name} ${job.status}/${job.conclusion}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
