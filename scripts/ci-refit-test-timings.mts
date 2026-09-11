#!/usr/bin/env -S node --import tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isRetryableGhJsonErrorMessage } from "./ci-run-timings.mjs";
import { refitTestTimings, type CiTimingRun } from "./lib/ci-test-timings-refit.mts";
import { ciTestTimingsSchema } from "./lib/ci-test-timings-schema.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";

const jobPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(
    z.object({
      id: z.number().int().positive(),
      run_id: z.number().int().positive(),
      run_attempt: z.number().int().positive(),
      head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime().nullable(),
      labels: z.array(z.string()),
    }),
  ),
});

async function readGh(args: string[]): Promise<string> {
  const retryDelays = [1000, 3000, 6000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execPlainGh(args, {
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (
        attempt === retryDelays.length ||
        !isRetryableGhJsonErrorMessage(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      await setTimeout(retryDelays[attempt]);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      runs: { type: "string", default: "5" },
      repo: { type: "string", default: "openclaw/openclaw" },
      "dry-run": { type: "boolean", default: false },
      out: {
        type: "string",
        default: fileURLToPath(new URL("../config/ci-test-timings.json", import.meta.url)),
      },
    },
  });
  const count = parsePositiveInt(values.runs, "--runs");
  const repo = z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/u)
    .parse(values.repo);
  // Freeze both bounds once. Pagination and retries must not move the cohort.
  const upper = new Date().toISOString();
  const lower = new Date(Date.parse(upper) - 7 * 86_400_000).toISOString();
  const inWindow = (timestamp: string) =>
    Date.parse(timestamp) >= Date.parse(lower) && Date.parse(timestamp) <= Date.parse(upper);
  const runSchema = z.object({
    id: z.number().int().positive(),
    run_attempt: z.number().int().positive(),
    created_at: z.iso.datetime().refine(inWindow, "created_at is outside the frozen UTC window"),
    status: z.literal("completed"),
    conclusion: z.literal("success"),
    event: z.string(),
    head_branch: z.string().min(1),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  });
  console.log(`Frozen UTC window: ${lower} through ${upper} (7 days).\n`);
  console.log("Release workflow SHAs identify tooling, not the measured target.\n");
  console.log(
    "| Source | Run | Attempt | Workflow SHA | Created (UTC) | Parsed profiles | Timing jobs |\n| --- | ---: | ---: | --- | --- | --- | ---: |",
  );
  // New gh versions reject reporter ANSI unless opted in; logs are parsed, never printed.
  const logFlags = (await readGh(["api", "--help"])).includes("--allow-escape-sequences")
    ? ["--allow-escape-sequences"]
    : [];
  const runs: CiTimingRun[] = [];
  const seenRuns = new Map<number, string>();
  const seenJobs = new Map<number, string>();
  async function readRun(run: z.infer<typeof runSchema>, source: "main" | "release") {
    const logs: CiTimingRun["logs"] = [];
    let pages = 0;
    // A partial retry omits successful original jobs. Read every captured attempt,
    // then give the refit one run so retries cannot become independent samples.
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const attemptLogs: CiTimingRun["logs"] = [];
      const jobIds = new Set<number>();
      let total: number | undefined;
      for (let page = 1; page <= 25; page += 1) {
        if (++pages > 25) {
          throw new Error(`Job pagination limit reached for run ${run.id}`);
        }
        const payload = jobPageSchema.parse(
          JSON.parse(
            await readGh([
              "api",
              `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
            ]),
          ),
        );
        if (total !== undefined && total !== payload.total_count) {
          throw new Error(`Job pagination changed for run ${run.id} attempt ${attempt}`);
        }
        total = payload.total_count;
        for (const job of payload.jobs) {
          if (
            job.run_id !== run.id ||
            job.run_attempt !== attempt ||
            job.head_sha !== run.head_sha
          ) {
            throw new Error(`Job ${job.id} run_id/run_attempt/head_sha does not match its cohort`);
          }
          const identity = JSON.stringify(job);
          if (seenJobs.has(job.id) && seenJobs.get(job.id) !== identity) {
            throw new Error(`Job ${job.id} changed during pagination`);
          }
          jobIds.add(job.id);
          if (seenJobs.has(job.id)) {
            continue;
          }
          seenJobs.set(job.id, identity);
          if (job.conclusion !== "success") {
            continue;
          }
          if (
            job.status !== "completed" ||
            !job.completed_at ||
            !inWindow(job.started_at) ||
            !inWindow(job.completed_at) ||
            Date.parse(job.completed_at) < Date.parse(job.started_at)
          ) {
            throw new Error(
              `Successful job ${job.id} is not completed inside the frozen UTC window`,
            );
          }
          const kind =
            source === "release"
              ? /(?:^| \/ )Repo E2E \(Gateway \d+\/\d+\)$/u.test(job.name)
                ? "repoE2e"
                : undefined
              : job.name.startsWith("checks-ui-e2e (")
                ? "uiE2e"
                : job.name.startsWith("checks-node-compact-")
                  ? "compact"
                  : undefined;
          if (kind) {
            console.error(`[ci-timings] ${run.id} attempt ${attempt}: ${job.name}`);
            attemptLogs.push({
              kind,
              labels: job.labels,
              text: await readGh(["api", `repos/${repo}/actions/jobs/${job.id}/logs`, ...logFlags]),
            });
          }
        }
        if (jobIds.size === total) {
          break;
        }
        if (jobIds.size > total || payload.jobs.length === 0 || page === 25) {
          throw new Error(`Job pagination incomplete for run ${run.id} attempt ${attempt}`);
        }
      }
      const { contributingRunIds } = refitTestTimings([
        { id: run.id, createdAt: run.created_at, logs: attemptLogs },
      ]);
      const profiles = Object.entries(contributingRunIds)
        .filter(([, ids]) => ids.length > 0)
        .map(([profile]) => profile);
      console.log(
        `| ${source} | ${run.id} | ${attempt} | ${run.head_sha} | ${run.created_at} | ${profiles.join(", ") || "none"} | ${attemptLogs.length} |`,
      );
      logs.push(...attemptLogs);
    }
    return { id: run.id, createdAt: run.created_at, logs };
  }
  async function sampleWorkflow(workflow: string, source: "main" | "release") {
    const pageSchema = z.object({
      total_count: z.number().int().nonnegative(),
      workflow_runs: z.array(
        runSchema.extend({
          // A dispatch from main can check out target_ref; only push runs prove the measured ref.
          event: z.literal(source === "main" ? "push" : "workflow_dispatch"),
          head_branch: source === "main" ? z.literal("main") : z.string().min(1),
        }),
      ),
    });
    const pageSize = Math.min(count, 100);
    const query = new URLSearchParams({
      ...(source === "main" ? { branch: "main" } : {}),
      event: source === "main" ? "push" : "workflow_dispatch",
      status: "success",
      created: `${lower}..${upper}`,
      per_page: String(pageSize),
    });
    const listed = new Set<number>();
    let listedRows = 0;
    let sampled = 0;
    // GitHub caps filtered searches at 1,000 results, even when total_count is larger.
    const maxPages = Math.min(25, Math.ceil(1000 / pageSize));
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = pageSchema.parse(
        JSON.parse(
          await readGh([
            "api",
            `repos/${repo}/actions/workflows/${workflow}/runs?${query}&page=${page}`,
          ]),
        ),
      );
      listedRows += payload.workflow_runs.length;
      if (listedRows > 1000) {
        throw new Error(`Run pagination limit reached for ${workflow}; reduce --runs`);
      }
      for (const run of payload.workflow_runs) {
        listed.add(run.id);
        const identity = JSON.stringify(run);
        if (seenRuns.has(run.id) && seenRuns.get(run.id) !== identity) {
          throw new Error(`Run ${run.id} changed during pagination`);
        }
        if (seenRuns.has(run.id)) {
          continue;
        }
        seenRuns.set(run.id, identity);
        const timingRun = await readRun(run, source);
        const { contributingRunIds } = refitTestTimings([timingRun]);
        const compact = contributingRunIds.blacksmith.length + contributingRunIds.github.length > 0;
        if (source === "main" ? compact : contributingRunIds.repoE2e.length > 0) {
          runs.push(timingRun);
        }
        if (source === "release" || compact) {
          sampled += 1;
        }
        if (sampled === count) {
          return;
        }
      }
      if (listed.size === payload.total_count) {
        return;
      }
      if (listed.size > payload.total_count || payload.workflow_runs.length === 0) {
        throw new Error(`Run pagination incomplete for ${workflow}`);
      }
    }
    throw new Error(`Run pagination limit reached for ${workflow}; reduce --runs`);
  }
  await sampleWorkflow("ci.yml", "main");
  const fresh = refitTestTimings(runs);
  const { blacksmith, github } = fresh.contributingRunIds;
  const mainContributors = new Set([...blacksmith, ...github]);
  if (
    mainContributors.size < 2 ||
    Object.values(fresh.timings.compactGroupSeconds).every(
      (profile) => Object.keys(profile).length === 0,
    )
  ) {
    throw new Error(
      `Found ${mainContributors.size} independent main compact contributors. Need at least two and a newly eligible compact measurement in the frozen UTC window; retry after successful main CI. No timing file written.`,
    );
  }
  // Release workflows validate their target before Gateway tests. Their head SHA
  // binds jobs to tooling, never substitutes for the measured source identity.
  for (const workflow of [
    "openclaw-release-checks.yml",
    "openclaw-live-and-e2e-checks-reusable.yml",
  ]) {
    await sampleWorkflow(workflow, "release");
  }
  let previous;
  try {
    previous = ciTestTimingsSchema.parse(JSON.parse(readFileSync(values.out, "utf8")));
  } catch {
    // A missing or invalid baseline has no measurements worth preserving.
  }
  const { timings, changes, runIds, contributingRunIds } = refitTestTimings(runs, previous);
  console.log(
    `\nIndependent main compact contributors: ${mainContributors.size} (Blacksmith: ${blacksmith.length}; GitHub: ${github.length}). Release Gateway contributors: ${contributingRunIds.repoE2e.length}.\n`,
  );
  ciTestTimingsSchema.parse(timings);
  console.log(`Sampled successful CI and release-check runs: ${runIds.join(", ")}\n`);
  console.log("| Key | Old seconds | New seconds | Delta |\n| --- | ---: | ---: | ---: |");
  for (const change of changes) {
    const delta =
      change.next === undefined
        ? "removed"
        : change.old === undefined || change.old === 0
          ? "new"
          : `${(((change.next - change.old) / change.old) * 100).toFixed(1)}%`;
    console.log(`| ${change.key} | ${change.old ?? "—"} | ${change.next ?? "—"} | ${delta} |`);
  }
  if (changes.length === 0) {
    console.log("\nNo timing changes exceed the 15% write threshold.");
  } else if (!values["dry-run"]) {
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(timings, null, 2)}\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[ci-timings] FAILED (exit 1)");
  process.exitCode = 1;
}
