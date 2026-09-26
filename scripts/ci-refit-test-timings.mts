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

type TimingJob = z.infer<typeof jobPageSchema>["jobs"][number] & {
  kind: CiTimingRun["logs"][number]["kind"];
};

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
      "tooling-run": { type: "string", multiple: true },
      "pull-request-run": { type: "string", multiple: true },
      repo: { type: "string", default: "openclaw/openclaw" },
      "dry-run": { type: "boolean", default: false },
      out: {
        type: "string",
        default: fileURLToPath(new URL("../config/ci-test-timings.json", import.meta.url)),
      },
    },
  });
  const count = parsePositiveInt(values.runs, "--runs");
  const toolingRunIds = [
    ...new Set((values["tooling-run"] ?? []).map((id) => parsePositiveInt(id, "--tooling-run"))),
  ];
  const seedTooling = toolingRunIds.length > 0;
  const pullRequestRunIds = [
    ...new Set(
      (values["pull-request-run"] ?? []).map((id) => parsePositiveInt(id, "--pull-request-run")),
    ),
  ];
  const seedPullRequest = pullRequestRunIds.length > 0;
  if (seedTooling && seedPullRequest) {
    throw new Error("Select either tooling or hosted PR qualification seeds");
  }
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
    conclusion: z.string().nullable(),
    event: z.string(),
    head_branch: z.string().min(1),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  });
  console.log(`Frozen UTC window: ${lower} through ${upper} (7 days).\n`);
  console.log("Release workflow SHAs identify tooling, not the measured target.\n");
  console.log(
    "PR tooling measurements execute the merge-ref; workflow/job SHAs identify the PR head.\n",
  );
  console.log(
    "| Source | Run | Attempt | Workflow SHA | Created (UTC) | Workflow result | Parsed profiles | Timing jobs |\n| --- | ---: | ---: | --- | --- | --- | --- | ---: |",
  );
  // New gh versions reject reporter ANSI unless opted in; logs are parsed, never printed.
  const logFlags = (await readGh(["api", "--help"])).includes("--allow-escape-sequences")
    ? ["--allow-escape-sequences"]
    : [];
  const runs: CiTimingRun[] = [];
  const seenRuns = new Map<number, string>();
  const seenJobs = new Map<number, string>();
  type TimingSource = "main" | "release" | "tooling" | "pull-request";
  async function readRun(run: z.infer<typeof runSchema>, source: TimingSource) {
    const logs: CiTimingRun["logs"] = [];
    const completeInventory = run.conclusion === "success";
    const jobsByAttempt: TimingJob[][] = [];
    let afterCutoff = false;
    let pages = 0;
    // A partial retry omits successful original jobs. Read every captured attempt,
    // then give the refit one run so retries cannot become independent samples.
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const timingJobs: TimingJob[] = [];
      jobsByAttempt.push(timingJobs);
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
        const observedAt = Date.now();
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
          if (job.conclusion !== "success" && source !== "pull-request") {
            continue;
          }
          if (
            job.status !== "completed" ||
            !job.completed_at ||
            Date.parse(job.started_at) < Date.parse(lower) ||
            Date.parse(job.completed_at) < Date.parse(job.started_at) ||
            Date.parse(job.completed_at) > observedAt
          ) {
            throw new Error(
              `Successful job ${job.id} is not completed inside the frozen UTC window`,
            );
          }
          afterCutoff ||= Date.parse(job.completed_at) > Date.parse(upper);
          const kind =
            source === "release"
              ? /(?:^| \/ )Repo E2E \(Gateway \d+\/\d+\)$/u.test(job.name)
                ? "repoE2e"
                : undefined
              : source === "pull-request"
                ? job.name.startsWith("checks-node-compact-") && job.labels.includes("ubuntu-24.04")
                  ? "compactPullRequest"
                  : undefined
                : source === "tooling"
                  ? job.name.startsWith("checks-node-compact-")
                    ? "tooling"
                    : undefined
                  : job.name.startsWith("checks-ui-e2e (")
                    ? "uiE2e"
                    : job.name.startsWith("checks-node-compact-")
                      ? "compact"
                      : undefined;
          if (kind) {
            timingJobs.push({ ...job, kind });
          }
        }
        if (jobIds.size === total) {
          break;
        }
        if (jobIds.size > total || payload.jobs.length === 0 || page === 25) {
          throw new Error(`Job pagination incomplete for run ${run.id} attempt ${attempt}`);
        }
      }
    }
    // A run can finish after the frozen cutoff while earlier cohorts download.
    // Validate every captured attempt first; dropping only its late jobs would
    // misrepresent a partial inventory as complete evidence for pruning.
    if (afterCutoff) {
      return null;
    }
    for (const [index, timingJobs] of jobsByAttempt.entries()) {
      const attempt = index + 1;
      const attemptLogs: CiTimingRun["logs"] = [];
      for (const job of timingJobs) {
        console.error(`[ci-timings] ${run.id} attempt ${attempt}: ${job.name}`);
        const text = await readGh([
          "api",
          `repos/${repo}/actions/jobs/${job.id}/logs`,
          ...logFlags,
        ]);
        attemptLogs.push({
          kind: job.kind,
          labels: job.labels,
          text,
          completeJob: job.conclusion === "success",
          jobId: job.id,
        });
        if (source === "tooling" && job.labels.includes("ubuntu-24.04") && !seedTooling) {
          attemptLogs.push({
            kind: "compactPullRequest",
            labels: job.labels,
            text,
            completeJob: true,
            jobId: job.id,
          });
        }
      }
      const { contributingRunIds } = refitTestTimings([
        { id: run.id, createdAt: run.created_at, logs: attemptLogs, completeInventory },
      ]);
      const profiles = Object.entries(contributingRunIds)
        .filter(([, ids]) => ids.length > 0)
        .map(([profile]) => profile);
      console.log(
        `| ${source} | ${run.id} | ${attempt} | ${run.head_sha} | ${run.created_at} | ${run.conclusion} | ${profiles.join(", ") || "none"} | ${attemptLogs.length} |`,
      );
      logs.push(...attemptLogs);
    }
    return {
      id: run.id,
      createdAt: run.created_at,
      logs,
      completeInventory,
    };
  }
  async function sampleWorkflow(workflow: string, source: TimingSource) {
    const event =
      source === "main" ? "push" : source === "tooling" ? "pull_request" : "workflow_dispatch";
    const pageSchema = z.object({
      total_count: z.number().int().nonnegative(),
      workflow_runs: z.array(
        runSchema.extend({
          conclusion: source === "main" ? z.string().nullable() : z.literal("success"),
          // PRs measure their merge-ref, which is appropriate only for PR-only
          // tooling. Their workflow/job head_sha identifies the PR head, not that merge.
          // A release dispatch can check out target_ref; push alone proves main.
          event: z.literal(event),
          head_branch: source === "main" ? z.literal("main") : z.string().min(1),
        }),
      ),
    });
    // Coalesced cancelled main tips must not exhaust pagination before usable runs.
    const pageSize = source === "main" ? 100 : Math.min(count, 100);
    const query = new URLSearchParams({
      ...(source === "main" ? { branch: "main" } : {}),
      event,
      status: source === "main" ? "completed" : "success",
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
        // Completed failed main runs still contain successful independent jobs.
        // Cancellation and other conclusions do not supply a timing cohort.
        if (run.conclusion !== "success" && run.conclusion !== "failure") {
          continue;
        }
        const timingRun = await readRun(run, source);
        if (timingRun === null) {
          console.error(
            `Skipped ${source} run ${run.id}: jobs completed after frozen UTC cutoff ${upper}.`,
          );
          continue;
        }
        const { contributingRunIds } = refitTestTimings([timingRun]);
        const compact = contributingRunIds.blacksmith.length + contributingRunIds.github.length > 0;
        const contributes =
          source === "main"
            ? compact
            : source === "tooling"
              ? contributingRunIds.toolingBlacksmith.length +
                  contributingRunIds.toolingGithub.length +
                  contributingRunIds.githubPullRequest.length >
                0
              : contributingRunIds.repoE2e.length > 0;
        if (contributes) {
          runs.push(timingRun);
        }
        if (source !== "main" || compact) {
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
  if (seedPullRequest) {
    const schema = runSchema.extend({
      path: z.literal(".github/workflows/ci.yml"),
      event: z.literal("pull_request"),
    });
    for (const id of pullRequestRunIds) {
      const run = schema.parse(
        JSON.parse(await readGh(["api", `repos/${repo}/actions/runs/${id}`])),
      );
      if (run.id !== id) {
        throw new Error(`Requested PR run ${id} returned run ${run.id}`);
      }
      const timingRun = await readRun(run, "pull-request");
      if (!timingRun) {
        throw new Error(`PR run ${id} completed after the frozen cutoff`);
      }
      runs.push(timingRun);
    }
    if (
      refitTestTimings(runs, undefined, { seedPullRequest: true }).contributingRunIds
        .githubPullRequest.length === 0
    ) {
      throw new Error("PR qualification runs supplied no complete hosted group measurements");
    }
  } else if (seedTooling) {
    const toolingRunSchema = runSchema.extend({
      conclusion: z.literal("success"),
      path: z.literal(".github/workflows/ci.yml"),
      event: z.literal("pull_request"),
    });
    for (const id of toolingRunIds) {
      const run = toolingRunSchema.parse(
        JSON.parse(await readGh(["api", `repos/${repo}/actions/runs/${id}`])),
      );
      if (run.id !== id) {
        throw new Error(`Requested tooling run ${id} returned run ${run.id}`);
      }
      const timingRun = await readRun(run, "tooling");
      if (timingRun === null) {
        throw new Error(
          `Requested tooling run ${id} has jobs completed after frozen UTC cutoff ${upper}.`,
        );
      }
      runs.push(timingRun);
    }
    const { contributingRunIds } = refitTestTimings(runs, undefined, { seedTooling: true });
    if (
      contributingRunIds.toolingBlacksmith.length + contributingRunIds.toolingGithub.length ===
      0
    ) {
      throw new Error(
        "Explicit PR runs supplied no complete tooling measurements. No timing file written.",
      );
    }
  } else {
    await sampleWorkflow("ci.yml", "main");
    const fresh = refitTestTimings(runs);
    const { blacksmith, github } = fresh.contributingRunIds;
    const mainContributors = new Set([...blacksmith, ...github]);
    if (
      mainContributors.size < 2 ||
      (Object.values(fresh.timings.compactGroupSeconds).every(
        (profile) => Object.keys(profile).length === 0,
      ) &&
        Object.values(fresh.timings.runtimePlacementTimings).every(
          (profile) => profile.length === 0,
        ))
    ) {
      throw new Error(
        `Found ${mainContributors.size} independent main compact contributors. Need at least two and a newly eligible compact measurement in the frozen UTC window; retry after main CI has successful timing jobs. No timing file written.`,
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
    await sampleWorkflow("ci.yml", "tooling");
  }
  let previous;
  try {
    previous = ciTestTimingsSchema.parse(JSON.parse(readFileSync(values.out, "utf8")));
  } catch {
    // A missing or invalid baseline has no measurements worth preserving.
  }
  const { timings, changes, runIds, contributingRunIds } = refitTestTimings(runs, previous, {
    seedTooling,
    seedPullRequest,
  });
  const { blacksmith, github, toolingBlacksmith, toolingGithub } = contributingRunIds;
  const mainContributors = new Set([...blacksmith, ...github]);
  console.log(
    `\nIndependent main compact contributors: ${mainContributors.size} (Blacksmith: ${blacksmith.length}; GitHub: ${github.length}). Release Gateway contributors: ${contributingRunIds.repoE2e.length}.\n`,
  );
  console.log(
    `Independent hosted PR compact contributors: ${contributingRunIds.githubPullRequest.length}.\n`,
  );
  console.log(
    `Independent PR tooling contributors: ${new Set([...toolingBlacksmith, ...toolingGithub]).size} (Blacksmith: ${toolingBlacksmith.length}; GitHub: ${toolingGithub.length}).${seedTooling ? " Explicit tooling seed; single-run measurements allowed." : ""}\n`,
  );
  ciTestTimingsSchema.parse(timings);
  console.log(
    `Sampled CI and release-check runs with successful timing jobs: ${runIds.join(", ")}\n`,
  );
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
