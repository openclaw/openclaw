import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./record-shared.mjs";
import { ReleaseRefusal, type ReleaseRunner } from "./release-stable-state.mts";
import { parseJson, positiveInteger } from "./release-stable-workflows.mts";

const PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const PLUGIN_NPM_WORKFLOW = ".github/workflows/plugin-npm-release.yml";
const BOOTSTRAP_WORKFLOW = ".github/workflows/plugin-clawhub-new.yml";
const PUBLICATION_CHILD_WORKFLOWS = [
  PLUGIN_NPM_WORKFLOW,
  ".github/workflows/plugin-clawhub-release.yml",
  BOOTSTRAP_WORKFLOW,
  ".github/workflows/openclaw-npm-release.yml",
] as const;
const PUBLISH_TOOLING_TAG = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
// A completed job with one of these conclusions needs an operator, even when
// continue-on-error keeps its run green (for example the Windows notify job).
const FAILED_JOB_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "startup_failure",
  "action_required",
]);
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1_000;
const MAX_JOB_PAGES = 10;
class PublicationSnapshotChanged extends Error {}
class PublicationDeadlineExceeded extends Error {}

function readOptions(deadlineAt: number | undefined): { timeoutMs?: number } {
  if (deadlineAt === undefined) {
    return {};
  }
  const timeoutMs = deadlineAt - Date.now();
  if (timeoutMs <= 0) {
    throw new PublicationDeadlineExceeded();
  }
  return { timeoutMs };
}

/**
 * The publish parent to observe. Retained release state supplies its tooling and
 * source identity; a bare `--run` derives tooling identity from the parent itself.
 */
export type PublicationWatchTarget = {
  repo: string;
  parentRunId: string;
  label: string;
  rerunCommand: string;
  tag?: string;
  toolingTag?: string;
  toolingSha?: string;
  releaseSha?: string;
  dispatchedAt?: string;
};

type ParentIdentity = {
  toolingTag: string;
  toolingSha: string;
  dispatchedAt: string;
  completedAt?: number;
};

type RunObservation = {
  id: string;
  attempt: number;
  workflow: string;
  status: string;
  conclusion: string | null;
  url: string;
};

type ApprovalObservation = {
  runId: string;
  workflow: string;
  environmentId: number;
  environment: string;
  canApprove: boolean | null;
};

type JobObservation = {
  runId: string;
  workflow: string;
  jobId: string;
  name: string;
  conclusion: string;
  url: string;
};

export type PublicationWatchSnapshot = {
  contractVersion: 1;
  observedAt: string;
  release: string;
  repository: string;
  state: "active" | "attention" | "success";
  parent: RunObservation;
  children: RunObservation[];
  pendingApprovals: ApprovalObservation[];
  failedRuns: RunObservation[];
  failedJobs: JobObservation[];
};

type WatchOptions = {
  once: boolean;
  json: boolean;
  pollSeconds: number;
  timeoutSeconds: number;
};

function workflowPath(run: Record<string, unknown>): string | undefined {
  return typeof run.path === "string" ? run.path.split("@")[0] : undefined;
}

function runObservation(run: Record<string, unknown>, expectedId?: string): RunObservation {
  const path = workflowPath(run);
  if (
    !positiveInteger(run.id) ||
    (expectedId !== undefined && String(run.id) !== expectedId) ||
    !positiveInteger(run.run_attempt) ||
    typeof run.status !== "string" ||
    (run.conclusion !== null && typeof run.conclusion !== "string") ||
    !path ||
    typeof run.html_url !== "string"
  ) {
    throw new Error(`Invalid Actions run${expectedId ? ` ${expectedId}` : ""}.`);
  }
  return {
    id: String(run.id),
    attempt: run.run_attempt,
    workflow: path,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
  };
}

async function readJson(
  run: ReleaseRunner,
  endpoint: string,
  label: string,
  deadlineAt?: number,
): Promise<unknown> {
  const result = await run("gh", ["api", endpoint], readOptions(deadlineAt));
  return parseJson(result.stdout, label);
}

async function readRun(
  run: ReleaseRunner,
  repo: string,
  id: string,
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  const value = await readJson(run, `repos/${repo}/actions/runs/${id}`, `run ${id}`, deadlineAt);
  if (!isRecord(value)) {
    throw new Error(`Invalid Actions run ${id}.`);
  }
  runObservation(value, id);
  return value;
}

function requireParentIdentity(
  target: PublicationWatchTarget,
  run: Record<string, unknown>,
): ParentIdentity {
  const toolingTag = typeof run.head_branch === "string" ? run.head_branch : "";
  const toolingSha = typeof run.head_sha === "string" ? run.head_sha : "";
  const dispatchedAt = target.dispatchedAt ?? run.created_at;
  if (
    workflowPath(run) !== PUBLISH_WORKFLOW ||
    run.event !== "workflow_dispatch" ||
    !isRecord(run.repository) ||
    run.repository.full_name !== target.repo ||
    PUBLISH_TOOLING_TAG.exec(toolingTag)?.[1] !== toolingSha.slice(0, 12) ||
    !/^[a-f0-9]{40}$/u.test(toolingSha) ||
    (target.toolingTag !== undefined && toolingTag !== target.toolingTag) ||
    (target.toolingSha !== undefined && toolingSha !== target.toolingSha) ||
    typeof dispatchedAt !== "string" ||
    !Number.isFinite(Date.parse(dispatchedAt))
  ) {
    throw new Error(
      `Run ${target.parentRunId} is not an OpenClaw Release Publish parent on a protected release-publish tag${target.toolingTag ? " matching retained release state" : ""}.`,
    );
  }
  // A completed parent dispatched nothing later; this keeps a resumed parent's
  // plugin npm run, which shares tooling and source, out of an earlier parent.
  const completedAt =
    run.status === "completed" && typeof run.updated_at === "string"
      ? Date.parse(run.updated_at)
      : undefined;
  return { toolingTag, toolingSha, dispatchedAt, completedAt };
}

// Each child's run-name records the exact parent run and attempt that dispatched
// it; plugin npm predates that tuple and is bound by tooling and source identity.
function isOwnedChild(
  target: PublicationWatchTarget,
  identity: ParentIdentity,
  parent: RunObservation,
  run: Record<string, unknown>,
): boolean {
  const path = workflowPath(run);
  if (
    !path ||
    !(PUBLICATION_CHILD_WORKFLOWS as readonly string[]).includes(path) ||
    run.event !== "workflow_dispatch" ||
    !isRecord(run.actor) ||
    run.actor.login !== "github-actions[bot]" ||
    !positiveInteger(run.id)
  ) {
    return false;
  }
  const title = typeof run.display_title === "string" ? run.display_title : "";
  const tooling = run.head_branch === identity.toolingTag && run.head_sha === identity.toolingSha;
  if (path === PLUGIN_NPM_WORKFLOW) {
    return (
      tooling &&
      (target.releaseSha
        ? title === `Plugin NPM Release [default] ${target.releaseSha}`
        : /^Plugin NPM Release \[default\] [a-f0-9]{40}$/u.test(title))
    );
  }
  const match = /^(\S+) \[(v[^\]\s]+)\] publish parent=([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(title);
  const parentTitle =
    match !== null &&
    match[1] === path.split("/").at(-1) &&
    match[3] === parent.id &&
    match[4] === String(parent.attempt) &&
    (target.tag === undefined || match[2] === target.tag);
  // Bootstrap publication uses the independently admitted bootstrap ref/SHA.
  return path === BOOTSTRAP_WORKFLOW ? parentTitle : parentTitle && tooling;
}

function createdAt(run: Record<string, unknown>): number {
  const time = typeof run.created_at === "string" ? Date.parse(run.created_at) : Number.NaN;
  if (!Number.isFinite(time)) {
    throw new Error("Publication child has an invalid creation time.");
  }
  return time;
}

function selectOwnedChildren(
  target: PublicationWatchTarget,
  identity: ParentIdentity,
  parent: RunObservation,
  values: unknown[],
): Record<string, unknown>[] {
  const owned = values
    .filter(isRecord)
    .filter((run) => isOwnedChild(target, identity, parent, run));
  const pluginNpm = owned
    .filter((run) => workflowPath(run) === PLUGIN_NPM_WORKFLOW)
    .filter((run) => identity.completedAt === undefined || createdAt(run) <= identity.completedAt)
    .toSorted((a, b) => createdAt(b) - createdAt(a));
  if (new Set(pluginNpm.map((run) => run.display_title)).size > 1) {
    throw new Error(
      "Plugin npm publication is ambiguous: several release sources share this tooling tag.",
    );
  }
  const explicit = owned.filter((run) => workflowPath(run) !== PLUGIN_NPM_WORKFLOW);
  for (const path of new Set(explicit.map(workflowPath))) {
    if (explicit.filter((run) => workflowPath(run) === path).length > 1) {
      throw new Error(`Publication child identity is ambiguous for ${path}.`);
    }
  }
  // Plugin npm titles predate parent tuples. The publisher serializes that lane,
  // so the newest exact source/tooling match supersedes terminal failed attempts.
  return [...pluginNpm.slice(0, 1), ...explicit];
}

async function listOwnedChildren(
  run: ReleaseRunner,
  target: PublicationWatchTarget,
  identity: ParentIdentity,
  parent: RunObservation,
  deadlineAt?: number,
): Promise<Record<string, unknown>[]> {
  const listed: unknown[] = [];
  // Per-workflow inventories stay bounded while unrelated dispatches run.
  for (const path of PUBLICATION_CHILD_WORKFLOWS) {
    const file = path.split("/").at(-1);
    const page = await readJson(
      run,
      `repos/${target.repo}/actions/workflows/${file}/runs?event=workflow_dispatch&per_page=100&created=>=${identity.dispatchedAt}`,
      `${file} child runs`,
      deadlineAt,
    );
    if (!isRecord(page) || !Array.isArray(page.workflow_runs) || page.workflow_runs.length >= 100) {
      throw new Error(`Publication child inventory for ${file} is invalid or truncated.`);
    }
    listed.push(...page.workflow_runs);
  }
  return selectOwnedChildren(target, identity, parent, listed);
}

async function readPendingApprovals(
  run: ReleaseRunner,
  repo: string,
  observed: RunObservation,
  deadlineAt?: number,
): Promise<ApprovalObservation[]> {
  const pending = await readJson(
    run,
    `repos/${repo}/actions/runs/${observed.id}/pending_deployments`,
    `pending deployments for ${observed.id}`,
    deadlineAt,
  );
  if (!Array.isArray(pending)) {
    throw new Error(`Invalid pending deployments for ${observed.id}.`);
  }
  return pending.map((value) => {
    if (
      !isRecord(value) ||
      !isRecord(value.environment) ||
      !positiveInteger(value.environment.id) ||
      typeof value.environment.name !== "string" ||
      (typeof value.current_user_can_approve !== "boolean" &&
        value.current_user_can_approve !== null)
    ) {
      throw new Error(`Invalid pending deployment for ${observed.id}.`);
    }
    return {
      runId: observed.id,
      workflow: observed.workflow,
      environmentId: value.environment.id,
      environment: value.environment.name,
      canApprove: value.current_user_can_approve,
    };
  });
}

async function readFailedJobs(
  run: ReleaseRunner,
  repo: string,
  observed: RunObservation,
  deadlineAt?: number,
): Promise<JobObservation[]> {
  const jobs: unknown[] = [];
  // Matrix children such as ClawHub publish hundreds of jobs; page to the bounded total.
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const listed = await readJson(
      run,
      `repos/${repo}/actions/runs/${observed.id}/attempts/${observed.attempt}/jobs?per_page=100&page=${page}`,
      `jobs for ${observed.id}`,
      deadlineAt,
    );
    if (
      !isRecord(listed) ||
      !Array.isArray(listed.jobs) ||
      !Number.isSafeInteger(listed.total_count)
    ) {
      throw new Error(`Job inventory for ${observed.id} is invalid.`);
    }
    jobs.push(...listed.jobs);
    if (jobs.length >= Number(listed.total_count) || listed.jobs.length === 0) {
      if (jobs.length !== listed.total_count) {
        throw new Error(`Job inventory for ${observed.id} changed while paging.`);
      }
      break;
    }
    if (page === MAX_JOB_PAGES) {
      throw new Error(`Job inventory for ${observed.id} exceeds ${MAX_JOB_PAGES * 100} jobs.`);
    }
  }
  return jobs.flatMap((job) => {
    if (
      !isRecord(job) ||
      !positiveInteger(job.id) ||
      typeof job.name !== "string" ||
      typeof job.html_url !== "string"
    ) {
      throw new Error(`Invalid job for ${observed.id}.`);
    }
    return job.status === "completed" &&
      typeof job.conclusion === "string" &&
      FAILED_JOB_CONCLUSIONS.has(job.conclusion)
      ? [
          {
            runId: observed.id,
            workflow: observed.workflow,
            jobId: String(job.id),
            name: job.name,
            conclusion: job.conclusion,
            url: job.html_url,
          },
        ]
      : [];
  });
}

async function observePublication(
  run: ReleaseRunner,
  target: PublicationWatchTarget,
  deadlineAt?: number,
): Promise<PublicationWatchSnapshot> {
  const parentId = target.parentRunId;
  const parentRun = await readRun(run, target.repo, parentId, deadlineAt);
  const identity = requireParentIdentity(target, parentRun);
  const parent = runObservation(parentRun, parentId);
  const candidates = await listOwnedChildren(run, target, identity, parent, deadlineAt);
  const children: RunObservation[] = [];
  for (const candidate of candidates) {
    const candidateId = String(candidate.id);
    const child = await readRun(run, target.repo, candidateId, deadlineAt);
    if (!isOwnedChild(target, identity, parent, child)) {
      throw new Error(`Publication child ${candidateId} identity changed while observing it.`);
    }
    children.push(runObservation(child, candidateId));
  }
  children.sort((a, b) => Number(a.id) - Number(b.id));
  if (parent.status === "completed" && parent.conclusion === "success") {
    if (!children.some((child) => child.workflow === PLUGIN_NPM_WORKFLOW)) {
      throw new Error("Completed publish parent has no observable plugin npm child.");
    }
  }
  const pendingApprovals: ApprovalObservation[] = [];
  const failedJobs: JobObservation[] = [];
  for (const observed of [parent, ...children]) {
    pendingApprovals.push(...(await readPendingApprovals(run, target.repo, observed, deadlineAt)));
    failedJobs.push(...(await readFailedJobs(run, target.repo, observed, deadlineAt)));
  }
  const finalCandidates = await listOwnedChildren(run, target, identity, parent, deadlineAt);
  if (
    finalCandidates.map((entry) => entry.id).join(",") !==
    candidates.map((entry) => entry.id).join(",")
  ) {
    throw new PublicationSnapshotChanged("Publication child inventory changed while observing it.");
  }
  const finalParentRun = await readRun(run, target.repo, parentId, deadlineAt);
  requireParentIdentity(target, finalParentRun);
  const finalParent = runObservation(finalParentRun, parentId);
  if (
    finalParent.attempt !== parent.attempt ||
    finalParent.status !== parent.status ||
    finalParent.conclusion !== parent.conclusion
  ) {
    throw new PublicationSnapshotChanged(
      "Publish parent changed while collecting its publication snapshot.",
    );
  }
  const failedRuns = [parent, ...children].filter(
    (observed) =>
      observed.status === "completed" &&
      observed.conclusion !== null &&
      observed.conclusion !== "success",
  );
  const attention = pendingApprovals.length > 0 || failedRuns.length > 0 || failedJobs.length > 0;
  const success =
    !attention &&
    parent.status === "completed" &&
    parent.conclusion === "success" &&
    children.every((child) => child.status === "completed" && child.conclusion === "success");
  return {
    contractVersion: 1,
    observedAt: new Date().toISOString(),
    release: target.label,
    repository: target.repo,
    state: attention ? "attention" : success ? "success" : "active",
    parent,
    children,
    pendingApprovals,
    failedRuns,
    failedJobs,
  };
}

function printSnapshot(snapshot: PublicationWatchSnapshot, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot));
    return;
  }
  console.log(
    `[release-watch] ${snapshot.release}: ${snapshot.state}; parent=${snapshot.parent.status}/${snapshot.parent.conclusion ?? "none"}; children=${snapshot.children.length}; approvals=${snapshot.pendingApprovals.length}; failures=${snapshot.failedRuns.length}; failedJobs=${snapshot.failedJobs.length}`,
  );
  for (const approval of snapshot.pendingApprovals) {
    console.log(
      `pending approval: run=${approval.runId} environment=${approval.environment} canApprove=${approval.canApprove ?? "unknown"} https://github.com/${snapshot.repository}/actions/runs/${approval.runId}`,
    );
  }
  for (const run of snapshot.failedRuns) {
    console.log(
      `failed publication run: ${run.workflow} run=${run.id} conclusion=${run.conclusion} ${run.url}`,
    );
  }
  for (const job of snapshot.failedJobs) {
    console.log(
      `failed publication job: ${job.workflow} run=${job.runId} job=${JSON.stringify(job.name)} conclusion=${job.conclusion} ${job.url}`,
    );
  }
}

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && /rate limit|HTTP 429/iu.test(error.message);
}

export async function watchPublication(
  run: ReleaseRunner,
  target: PublicationWatchTarget,
  options: WatchOptions,
): Promise<PublicationWatchSnapshot> {
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const timeout = () =>
    new ReleaseRefusal("Publication watcher timed out while the release was still active.", [
      target.rerunCommand,
    ]);
  const waitForNextRead = async (ms = options.pollSeconds * 1_000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timeout();
    }
    await delay(Math.min(ms, remaining));
  };
  let previous = "";
  let first = true;
  let rateLimitBackoffMs = 0;
  while (true) {
    if (!first && Date.now() >= deadline) {
      throw timeout();
    }
    first = false;
    let snapshot: PublicationWatchSnapshot;
    try {
      snapshot = await observePublication(run, target, deadline);
      rateLimitBackoffMs = 0;
    } catch (error) {
      if (error instanceof PublicationDeadlineExceeded) {
        throw timeout();
      }
      if (options.once) {
        throw error;
      }
      if (isRateLimited(error)) {
        // Back off past the poll interval instead of spending the remaining quota.
        rateLimitBackoffMs = Math.min(
          MAX_RATE_LIMIT_BACKOFF_MS,
          Math.max(options.pollSeconds * 2_000, rateLimitBackoffMs * 2),
        );
        console.error(
          `[release-watch] GitHub rate limit reached; retrying in ${Math.round(rateLimitBackoffMs / 1_000)}s.`,
        );
        await waitForNextRead(rateLimitBackoffMs);
        continue;
      }
      if (!(error instanceof PublicationSnapshotChanged)) {
        throw error;
      }
      await waitForNextRead();
      continue;
    }
    const fingerprint = JSON.stringify({
      state: snapshot.state,
      parent: snapshot.parent,
      children: snapshot.children,
      pendingApprovals: snapshot.pendingApprovals,
      failedRuns: snapshot.failedRuns,
      failedJobs: snapshot.failedJobs,
    });
    if (options.once || snapshot.state !== "active") {
      printSnapshot(snapshot, options.json);
      return snapshot;
    }
    if (!options.json && fingerprint !== previous) {
      printSnapshot(snapshot, false);
      previous = fingerprint;
    }
    await waitForNextRead();
  }
}
