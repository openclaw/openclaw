// Historical release-priority recovery records identify workflows deferred by
// the former repository-variable gate. Current release validation shares runner
// capacity with PR CI and does not pause or cancel unrelated workflows.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RELEASE_PRIORITY_VARIABLE = "OPENCLAW_RELEASE_PRIORITY_RUN";
export const RELEASE_PRIORITY_RECORD_KIND = "openclaw.frv-release-priority";
const CI_GATE_JOB = "openclaw/ci-gate";
// Workflows retained for restoring runs deferred by the former variable gate.
// Security Review stays live: it owns approval revocation for openclaw/ci-gate.
const RELEASE_PRIORITY_WORKFLOWS = Object.freeze([
  "CI",
  "Auto response",
  "PR context and evidence",
  "Labeler",
  "CodeQL",
  "CodeQL Critical Quality",
  "CodeQL macOS Critical Security",
  "CodeQL Android Critical Security",
  "Periphery Dead Code Comment",
  "Workflow Sanity",
  "ClawSweeper Dispatch",
  "Maintainer Command Reactions",
]);
const QUEUED_STATUSES = new Set(["queued", "pending", "waiting"]);

export function isReleaseBranch(name) {
  return /^release(?:-ci|-publish)?\//u.test(String(name ?? ""));
}

// Release children are dispatched; operator dispatches keep their intent.
export function isDeferrableRun(run, parentRunId) {
  return (
    RELEASE_PRIORITY_WORKFLOWS.includes(run?.name) &&
    run.event !== "workflow_dispatch" &&
    !isReleaseBranch(run.head_branch) &&
    String(run.id) !== String(parentRunId)
  );
}

export function describeRun(run) {
  const pullRequests = run.pull_requests ?? [];
  const pullRequest = pullRequests.length === 1 ? pullRequests[0].number : undefined;
  const repository = run.head_repository?.id;
  // Forks often reuse branch names. Prefer the PR concurrency owner when GitHub supplies it.
  const lane =
    Number.isSafeInteger(pullRequest) && pullRequest > 0
      ? `pr:${pullRequest}`
      : Number.isSafeInteger(repository) && repository > 0
        ? `repository:${repository}:branch:${String(run.head_branch ?? "")}`
        : `run:${run.id}`;
  return {
    event: String(run.event ?? ""),
    headBranch: String(run.head_branch ?? ""),
    id: String(run.id),
    lane,
    name: String(run.name ?? ""),
    url: String(run.html_url ?? ""),
  };
}

export function selectQueuedRunsToCancel(runs, parentRunId) {
  return runs
    .filter((run) => QUEUED_STATUSES.has(run.status) && isDeferrableRun(run, parentRunId))
    .map(describeRun);
}

// Gated workflows end skipped; a deferred CI run skips every lane and its gate
// fails naming the release, which keeps the PR unmergeable until the rerun.
export function selectDeferredRunCandidates(runs, record) {
  return runs.filter(
    (run) =>
      run.status === "completed" &&
      String(run.created_at ?? "") >= record.recordedAt &&
      isDeferrableRun(run, record.parentRunId) &&
      (run.name === "CI" ? run.conclusion === "failure" : run.conclusion === "skipped"),
  );
}

// A deferred CI run skips preflight and every lane behind it; the gate fails
// naming the release and security-fast (`!cancelled()`) still executes.
export function isDeferredCiJobSet(jobs) {
  return (
    jobs.some((job) => job.name === "preflight" && job.conclusion === "skipped") &&
    jobs.some((job) => job.name === CI_GATE_JOB && job.conclusion === "failure") &&
    jobs.every(
      (job) =>
        job.name === CI_GATE_JOB || job.name === "security-fast" || job.conclusion === "skipped",
    )
  );
}

// A PR's CI groups by PR number with cancel-in-progress. Unknown identities stay
// separate rather than suppressing an independent run with the same branch name.
export function selectLatestRunsPerLane(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = `${run.name}\n${run.lane}`;
    if (!latest.has(key) || Number(latest.get(key).id) < Number(run.id)) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

// Repeated prioritization keeps the original pause window and every
// cancellation it already recorded.
export function mergeReleasePriorityRecord(previous, next) {
  if (!previous) {
    return next;
  }
  if (previous.parentRunId !== next.parentRunId) {
    throw new Error(`release priority record belongs to parent ${previous.parentRunId}`);
  }
  const known = new Set(previous.cancelled.map((run) => run.id));
  return {
    ...previous,
    cancelled: [...previous.cancelled, ...next.cancelled.filter((run) => !known.has(run.id))],
  };
}

export function isQueuedRun(run) {
  return QUEUED_STATUSES.has(run?.status);
}

export function defaultReleasePriorityRecordPath(parentRunId) {
  return `.artifacts/frv-release-priority-${parentRunId}.json`;
}

export function writeReleasePriorityRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function readReleasePriorityRecord(path, options = {}) {
  if (options.optional && !existsSync(path)) {
    return null;
  }
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (
    record?.kind !== RELEASE_PRIORITY_RECORD_KIND ||
    !/^[1-9][0-9]*$/u.test(String(record.parentRunId)) ||
    Number.isNaN(Date.parse(record.recordedAt)) ||
    !Array.isArray(record.cancelled) ||
    record.cancelled.some((run) => !/^[1-9][0-9]*$/u.test(String(run?.id)))
  ) {
    throw new Error(`release priority record is invalid: ${path}`);
  }
  for (const run of record.cancelled) {
    run.id = String(run.id);
  }
  return record;
}

const ACTIONS_RUN_SEARCH_LIMIT = 1_000;
const ACTIONS_RUN_PAGE_SIZE = 100;

/** GitHub caps a filtered run search at 1,000 results, even with pagination. */
async function listReleasePriorityRunWindow(since, readPage, until = Date.now()) {
  const start = Date.parse(since);
  if (!Number.isFinite(start) || !Number.isFinite(until) || start > until) {
    throw new Error("Invalid release-priority timestamp window");
  }
  const runs = new Map();
  async function collect(from, to) {
    const created = `${new Date(from).toISOString()}..${new Date(to).toISOString()}`;
    const page = async (number) => {
      const result = await readPage(created, number, ACTIONS_RUN_PAGE_SIZE);
      if (
        !Number.isSafeInteger(result?.total_count) ||
        result.total_count < 0 ||
        !Array.isArray(result.workflow_runs) ||
        result.workflow_runs.some((run) => !Number.isSafeInteger(run?.id) || run.id < 1)
      ) {
        throw new Error("Invalid GitHub Actions run inventory");
      }
      return result;
    };
    const first = await page(1);
    if (first.total_count > ACTIONS_RUN_SEARCH_LIMIT) {
      // Overlap the boundary second and deduplicate IDs: no timestamp precision
      // assumption may discard a run at the split. A dense second fails closed.
      const middle = Math.floor((from + (to - from) / 2) / 1_000) * 1_000;
      if (middle <= from || middle >= to) {
        throw new Error("GitHub run search exceeds its cap within one timestamp window");
      }
      await collect(middle, to);
      await collect(from, middle);
      return;
    }
    const windowRuns = new Map(first.workflow_runs.map((run) => [run.id, run]));
    for (let number = 2; number <= Math.ceil(first.total_count / ACTIONS_RUN_PAGE_SIZE); number++) {
      const next = await page(number);
      if (next.total_count !== first.total_count) {
        throw new Error("GitHub Actions run inventory changed during discovery");
      }
      for (const run of next.workflow_runs) {
        windowRuns.set(run.id, run);
      }
    }
    if (windowRuns.size !== first.total_count) {
      throw new Error("Incomplete GitHub Actions run inventory");
    }
    for (const [id, run] of windowRuns) {
      runs.set(id, run);
    }
  }
  await collect(start, until);
  return [...runs.values()];
}

/** Queue snapshots remain best-effort; restoration must cover its whole pause window. */
export async function listReleasePriorityRuns(query, apiJson, apiText) {
  const parameters = new URLSearchParams(query);
  const created = parameters.get("created");
  if (created?.startsWith(">=")) {
    return listReleasePriorityRunWindow(created.slice(2), (window, page, pageSize) => {
      const bounded = new URLSearchParams(parameters);
      bounded.set("created", window);
      bounded.set("per_page", String(pageSize));
      bounded.set("page", String(page));
      return apiJson(`actions/runs?${bounded}`);
    });
  }
  const output = await apiText(`actions/runs?${query}&per_page=100`, ".workflow_runs[] | @json");
  return output
    ? output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
