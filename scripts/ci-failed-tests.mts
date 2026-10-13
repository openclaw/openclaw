import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import pLimit from "p-limit";
import { z } from "zod";
import { createMainFailureClassifier, readCiRunJobs } from "./ci-known-main-red.mjs";
import { extractNodeFailedTests } from "./lib/ci-node-test-evidence.mjs";
import { execGhReadAsync } from "./lib/plain-gh.mjs";

const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  path: z.string(),
  status: z.string(),
  run_number: z.number(),
  html_url: z.string(),
});
type Run = z.infer<typeof runSchema>;
type Job = {
  id: number;
  name: string;
  conclusion: string;
  html_url: string;
  steps?: { name: string; conclusion: string }[];
};
export type Api = (route: string, text?: boolean) => Promise<unknown>;
type FailedFile = { file: string; tests: string[] };
type Failure = {
  job: string;
  class: string;
  files: FailedFile[];
  url: string;
  failedSteps: string[];
  reason: string;
};
const CONTROL_JOBS = new Set([
  "pr-failure-report",
  "openclaw/ci-gate",
  "Seal full release child evidence",
]);
const usage =
  "Usage: pnpm test:ci-failed <pr-number|run-id|run-or-pr-url> [--repo owner/repo] [--include-pre-existing] [--run] [--json]";

export function parseArgs(argv: string[]) {
  const options = {
    target: "",
    repo: "openclaw/openclaw",
    includePreExisting: false,
    run: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      options.repo = arg === "--repo" ? (argv[++i] ?? "") : arg.slice(7);
    } else if (arg === "--include-pre-existing") {
      options.includePreExisting = true;
    } else if (arg === "--run") {
      options.run = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (["--help", "-h"].includes(arg)) {
      options.help = true;
    } else if (!options.target && !arg.startsWith("-")) {
      options.target = arg;
    } else {
      throw new Error(usage);
    }
  }
  if ((!options.target && !options.help) || !/^[\w.-]+\/[\w.-]+$/u.test(options.repo)) {
    throw new Error(usage);
  }
  return options;
}

export function parseTarget(target: string, repo: string) {
  const url =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|actions\/runs)\/(\d+)(?:[/?#].*)?$/u.exec(
      target,
    );
  if (url && url[1] !== repo) {
    throw new Error("Target URL repository differs from --repo");
  }
  const id = Number(url?.[3] ?? target);
  if (!Number.isSafeInteger(id) || id <= 0 || (!url && !/^\d+$/u.test(target))) {
    throw new Error(usage);
  }
  // GitHub run IDs exceed the PR-number range; URLs disambiguate either explicitly.
  return { kind: url ? (url[2] === "pull" ? "pr" : "run") : id < 1_000_000_000 ? "pr" : "run", id };
}

export async function resolveRun(target: string, repo: string, api: Api): Promise<Run> {
  const parsed = parseTarget(target, repo);
  let run: Run;
  if (parsed.kind === "run") {
    run = runSchema.parse(await api(`/actions/runs/${parsed.id}`));
  } else {
    const pull = z
      .object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }) })
      .parse(await api(`/pulls/${parsed.id}`));
    const inventory = z
      .object({ workflow_runs: z.array(runSchema) })
      .parse(
        await api(
          `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
        ),
      );
    const runs: Run[] = inventory.workflow_runs;
    const latest = runs
      .filter(
        (entry) =>
          entry.head_sha === pull.head.sha && ["completed", "in_progress"].includes(entry.status),
      )
      .toSorted((a, b) => b.run_number - a.run_number || b.id - a.id)[0];
    if (!latest) {
      throw new Error("No completed or in-progress ci.yml run for the PR head");
    }
    run = latest;
  }
  if (run.path !== ".github/workflows/ci.yml") {
    throw new Error("Target run is not ci.yml");
  }
  return run;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function rerunArgs(failures: Failure[], includePreExisting = false) {
  const files = new Map<string, { names: Set<string>; whole: boolean }>();
  for (const failure of failures) {
    if (failure.class === "pre-existing" && !includePreExisting) {
      continue;
    }
    for (const entry of failure.files) {
      const selected = files.get(entry.file) ?? { names: new Set<string>(), whole: false };
      selected.whole ||= entry.tests.length === 0;
      for (const test of entry.tests) {
        selected.names.add(test);
      }
      files.set(entry.file, selected);
    }
  }
  if (files.size === 0) {
    return [];
  }
  const args = ["test", ...[...files.keys()].toSorted((a, b) => a.localeCompare(b))];
  const single = files.size === 1 ? [...files.values()][0] : undefined;
  const names = single ? [...single.names].toSorted((a, b) => a.localeCompare(b)) : [];
  if (
    single &&
    !single.whole &&
    names.length > 0 &&
    names.length <= 3 &&
    names.every((name) => /^[\w .,:/()>+!?-]+$/u.test(name))
  ) {
    args.push("--", "-t", names.map(escapeRegex).join("|"));
  }
  return args;
}

export function formatCommand(args: string[]) {
  if (!args.length) {
    return null;
  }
  return `pnpm ${args.map((arg, index) => (index > 0 && args[index - 1] === "-t" ? `'${arg.replaceAll("'", "'\\''")}'` : arg)).join(" ")}`;
}

export async function collectFailures(run: Run, repo: string, api: Api) {
  const options = { repository: repo, api };
  const jobs: Job[] = await readCiRunJobs(options, run);
  const classifier = createMainFailureClassifier(options);
  // Shared gh transport bounds concurrent job and main-evidence reads to four.
  const failures: Failure[] = await Promise.all(
    jobs
      .filter(
        (entry) =>
          ["failure", "timed_out"].includes(entry.conclusion) && !CONTROL_JOBS.has(entry.name),
      )
      .map(async (job) => {
        const classification = await classifier.classifyJob(job);
        let files: FailedFile[] = [];
        let reason = classification.reason;
        try {
          files = extractNodeFailedTests(
            z.string().parse(await api(`/actions/jobs/${job.id}/logs`, true)),
          );
        } catch {
          reason += "; job log unavailable";
        }
        return {
          job: job.name,
          class: classification.class,
          files,
          url: job.html_url,
          failedSteps: (job.steps ?? [])
            .filter((step) => ["failure", "timed_out"].includes(step.conclusion))
            .map((step) => step.name),
          reason,
        };
      }),
  );
  return failures.toSorted(
    (a, b) =>
      Number(a.class === "pre-existing") - Number(b.class === "pre-existing") ||
      a.job.localeCompare(b.job) ||
      a.url.localeCompare(b.url),
  );
}

export function formatFailures(run: Run, failures: Failure[], command: string | null) {
  const lines = [`CI run ${run.id}: ${run.html_url} (head ${run.head_sha}, ${run.status})`];
  let preExisting = false;
  for (const failure of failures) {
    if (failure.class === "pre-existing" && !preExisting) {
      lines.push("", "Pre-existing failures (excluded unless --include-pre-existing):");
      preExisting = true;
    }
    lines.push("", `${failure.job} [${failure.class}]`, `  ${failure.reason}`);
    for (const entry of failure.files) {
      lines.push(`  ${entry.file}`, ...entry.tests.map((test) => `    > ${test}`));
    }
    if (!failure.files.length) {
      lines.push(
        ...failure.failedSteps.map((step) => `  failed step: ${step}`),
        `  no Vitest rerun; read log ${failure.url}`,
      );
    }
  }
  lines.push("", command ? `Rerun: ${command}` : "No selected Vitest failures to rerun.");
  return lines.join("\n");
}

function ghApi(repo: string): Api {
  const reads = new Map<string, Promise<unknown>>();
  const limit = pLimit(4);
  return (route, text = false) => {
    const key = `${text}:${route}`;
    if (!reads.has(key)) {
      reads.set(
        key,
        limit(async () => {
          const body = await execGhReadAsync(["api", `repos/${repo}${route}`, "--method", "GET"]);
          return text ? body : JSON.parse(body);
        }),
      );
    }
    return reads.get(key)!;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const api = ghApi(options.repo);
  const run = await resolveRun(options.target, options.repo, api);
  const failures = await collectFailures(run, options.repo, api);
  const args = rerunArgs(failures, options.includePreExisting);
  const command = formatCommand(args);
  console.log(
    options.json
      ? JSON.stringify({ run, failures, command })
      : formatFailures(run, failures, command),
  );
  if (options.run && command) {
    const child = spawnSync("pnpm", args, {
      stdio: options.json ? ["inherit", 2, 2] : "inherit",
    });
    if (child.error) {
      throw child.error;
    }
    process.exitCode = child.status ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "CI failure discovery failed");
    process.exitCode = 1;
  });
}
