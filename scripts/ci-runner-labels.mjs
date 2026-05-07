#!/usr/bin/env node

import { appendFileSync } from "node:fs";

export const RUNNER_LABELS = {
  runner_4vcpu_ubuntu: {
    fallback: "ubuntu-24.04",
    family: "ubuntu-2404",
    primary: "blacksmith-4vcpu-ubuntu-2404",
  },
  runner_8vcpu_ubuntu: {
    fallback: "ubuntu-24.04",
    family: "ubuntu-2404",
    primary: "blacksmith-8vcpu-ubuntu-2404",
  },
  runner_16vcpu_ubuntu: {
    fallback: "ubuntu-24.04",
    family: "ubuntu-2404",
    primary: "blacksmith-16vcpu-ubuntu-2404",
  },
  runner_16vcpu_windows: {
    fallback: "windows-2025",
    family: "windows-2025",
    primary: "blacksmith-16vcpu-windows-2025",
  },
  runner_6vcpu_macos: {
    fallback: "macos-latest",
    family: "macos-latest",
    primary: "blacksmith-6vcpu-macos-latest",
  },
  runner_12vcpu_macos: {
    fallback: "macos-latest",
    family: "macos-latest",
    primary: "blacksmith-12vcpu-macos-latest",
  },
};

const DEFAULT_REPOSITORY = "openclaw/openclaw";
const DEFAULT_QUEUE_THRESHOLD = 1;
const MAX_RUNS_TO_SCAN = 8;
const MAX_JOB_PAGES_PER_RUN = 2;

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "") {
    return false;
  }
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function selectRunnerLabels({
  canonicalRepository = true,
  fallbackEnabled = true,
  queuedCountsByLabel = {},
  queueThreshold = DEFAULT_QUEUE_THRESHOLD,
} = {}) {
  const selected = {};
  const queuedCountsByFamily = {};
  for (const [label, count] of Object.entries(queuedCountsByLabel)) {
    const family = Object.values(RUNNER_LABELS).find((runner) => runner.primary === label)?.family;
    if (family) {
      queuedCountsByFamily[family] = (queuedCountsByFamily[family] ?? 0) + count;
    }
  }
  for (const [outputName, label] of Object.entries(RUNNER_LABELS)) {
    const queuedCount = queuedCountsByLabel[label.primary] ?? 0;
    const familyQueuedCount = queuedCountsByFamily[label.family] ?? 0;
    selected[outputName] =
      !canonicalRepository ||
      (fallbackEnabled && (queuedCount >= queueThreshold || familyQueuedCount >= queueThreshold))
        ? label.fallback
        : label.primary;
  }
  return selected;
}

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function collectQueuedBlacksmithJobs({ repository, token }) {
  const [queuedRuns, inProgressRuns] = await Promise.all([
    githubApi(
      `repos/${repository}/actions/runs?status=queued&per_page=${MAX_RUNS_TO_SCAN}&exclude_pull_requests=true`,
      token,
    ),
    githubApi(
      `repos/${repository}/actions/runs?status=in_progress&per_page=${MAX_RUNS_TO_SCAN}&exclude_pull_requests=true`,
      token,
    ),
  ]);
  const runsById = new Map();
  for (const run of [
    ...(queuedRuns.workflow_runs ?? []),
    ...(inProgressRuns.workflow_runs ?? []),
  ]) {
    runsById.set(run.id, run);
  }

  const counts = {};
  await Promise.all(
    [...runsById.values()].map(async (run) => {
      const runCounts = {};
      for (let page = 1; page <= MAX_JOB_PAGES_PER_RUN; page += 1) {
        const jobs = await githubApi(
          `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`,
          token,
        );
        for (const job of jobs.jobs ?? []) {
          if (job.status !== "queued") {
            continue;
          }
          for (const label of job.labels ?? []) {
            if (typeof label === "string" && label.startsWith("blacksmith-")) {
              runCounts[label] = (runCounts[label] ?? 0) + 1;
            }
          }
        }
        if ((jobs.jobs ?? []).length < 100) {
          break;
        }
      }
      for (const [label, count] of Object.entries(runCounts)) {
        counts[label] = (counts[label] ?? 0) + count;
      }
    }),
  );
  return counts;
}

function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.log(JSON.stringify(outputs, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${String(value)}\n`, "utf8");
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const canonicalRepository = repository === DEFAULT_REPOSITORY;
  const fallbackEnabled = parseBoolean(process.env.OPENCLAW_CI_BLACKSMITH_FALLBACK, true);
  const queueThreshold = parsePositiveInteger(
    process.env.OPENCLAW_CI_BLACKSMITH_QUEUE_FALLBACK_THRESHOLD,
    DEFAULT_QUEUE_THRESHOLD,
  );
  let queuedCountsByLabel = {};

  if (canonicalRepository && fallbackEnabled && process.env.GITHUB_TOKEN) {
    try {
      queuedCountsByLabel = await collectQueuedBlacksmithJobs({
        repository,
        token: process.env.GITHUB_TOKEN,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`::warning title=Blacksmith fallback probe failed::${message}`);
    }
  }

  const selected = selectRunnerLabels({
    canonicalRepository,
    fallbackEnabled,
    queuedCountsByLabel,
    queueThreshold,
  });

  console.log(
    JSON.stringify(
      {
        fallbackEnabled,
        queueThreshold,
        queuedCountsByLabel,
        selected,
      },
      null,
      2,
    ),
  );
  writeOutputs(selected);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
