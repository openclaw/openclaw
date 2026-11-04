import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./record-shared.mjs";
import {
  ReleaseRefusal,
  shellCommand,
  type ReleaseContext,
  type ReleaseState,
} from "./release-stable-state.mts";
import { parseJson, positiveInteger } from "./release-stable-workflows.mts";

const PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const CHILD_WORKFLOWS = new Set([
  ".github/workflows/openclaw-npm-release.yml",
  ".github/workflows/plugin-npm-release.yml",
  ".github/workflows/plugin-clawhub-release.yml",
  ".github/workflows/plugin-clawhub-new.yml",
]);
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

async function readRun(
  ctx: ReleaseContext,
  id: string,
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  const result = await ctx.run(
    "gh",
    ["api", `repos/${ctx.state.repo}/actions/runs/${id}`],
    readOptions(deadlineAt),
  );
  const run = parseJson(result.stdout, `run ${id}`);
  if (!isRecord(run)) {
    throw new Error(`Invalid Actions run ${id}.`);
  }
  runObservation(run, id);
  return run;
}

function requireParentIdentity(state: ReleaseState, run: Record<string, unknown>): void {
  if (
    workflowPath(run) !== PUBLISH_WORKFLOW ||
    run.head_branch !== state.validate.toolingTag ||
    run.head_sha !== state.validate.toolingSha ||
    !isRecord(run.repository) ||
    run.repository.full_name !== state.repo
  ) {
    throw new Error(
      `Publish parent ${state.publish.publishRunId} identity does not match retained release state.`,
    );
  }
}

function isOwnedChild(
  state: ReleaseState,
  parent: RunObservation,
  run: Record<string, unknown>,
): boolean {
  const path = workflowPath(run);
  if (
    !path ||
    !CHILD_WORKFLOWS.has(path) ||
    run.event !== "workflow_dispatch" ||
    !isRecord(run.actor) ||
    run.actor.login !== "github-actions[bot]" ||
    !positiveInteger(run.id)
  ) {
    return false;
  }
  const filename = path.split("/").at(-1);
  const title = typeof run.display_title === "string" ? run.display_title : "";
  if (path === ".github/workflows/plugin-npm-release.yml") {
    return (
      run.head_branch === state.validate.toolingTag &&
      run.head_sha === state.validate.toolingSha &&
      title === `Plugin NPM Release [default] ${state.cut.releaseSha}`
    );
  }
  const parentTitle =
    title === `${filename} [${state.tag}] publish parent=${parent.id}/${parent.attempt}`;
  if (path === ".github/workflows/plugin-clawhub-new.yml") {
    // Bootstrap publication uses the independently admitted bootstrap ref/SHA.
    return parentTitle;
  }
  return (
    parentTitle &&
    run.head_branch === state.validate.toolingTag &&
    run.head_sha === state.validate.toolingSha
  );
}

function selectOwnedChildren(
  state: ReleaseState,
  parent: RunObservation,
  values: unknown[],
): Record<string, unknown>[] {
  const owned = values.filter(isRecord).filter((run) => isOwnedChild(state, parent, run));
  const pluginNpm = owned
    .filter((run) => workflowPath(run) === ".github/workflows/plugin-npm-release.yml")
    .toSorted((a, b) => {
      const aTime = typeof a.created_at === "string" ? Date.parse(a.created_at) : Number.NaN;
      const bTime = typeof b.created_at === "string" ? Date.parse(b.created_at) : Number.NaN;
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) {
        throw new Error("Publication child has an invalid creation time.");
      }
      return bTime - aTime;
    })
    .slice(0, 1);
  const explicit = owned.filter(
    (run) => workflowPath(run) !== ".github/workflows/plugin-npm-release.yml",
  );
  for (const path of new Set(explicit.map(workflowPath))) {
    if (explicit.filter((run) => workflowPath(run) === path).length > 1) {
      throw new Error(`Publication child identity is ambiguous for ${path}.`);
    }
  }
  // Plugin npm titles predate parent tuples. The publisher serializes that lane,
  // so the newest exact source/tooling match supersedes terminal failed attempts.
  return [...pluginNpm, ...explicit];
}

async function listOwnedChildren(
  ctx: ReleaseContext,
  state: ReleaseState,
  parent: RunObservation,
  dispatchedAt: string,
  deadlineAt?: number,
): Promise<Record<string, unknown>[]> {
  const result = await ctx.run(
    "gh",
    [
      "api",
      `repos/${state.repo}/actions/runs?event=workflow_dispatch&per_page=100&created=>=${dispatchedAt}`,
    ],
    readOptions(deadlineAt),
  );
  const listed = parseJson(result.stdout, "publication child runs");
  if (
    !isRecord(listed) ||
    !Array.isArray(listed.workflow_runs) ||
    listed.workflow_runs.length >= 100
  ) {
    throw new Error("Publication child inventory is invalid or truncated.");
  }
  return selectOwnedChildren(state, parent, listed.workflow_runs);
}

async function readPendingApprovals(
  ctx: ReleaseContext,
  run: RunObservation,
  deadlineAt?: number,
): Promise<ApprovalObservation[]> {
  const result = await ctx.run(
    "gh",
    ["api", `repos/${ctx.state.repo}/actions/runs/${run.id}/pending_deployments`],
    readOptions(deadlineAt),
  );
  const pending = parseJson(result.stdout, `pending deployments for ${run.id}`);
  if (!Array.isArray(pending)) {
    throw new Error(`Invalid pending deployments for ${run.id}.`);
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
      throw new Error(`Invalid pending deployment for ${run.id}.`);
    }
    return {
      runId: run.id,
      workflow: run.workflow,
      environmentId: value.environment.id,
      environment: value.environment.name,
      canApprove: value.current_user_can_approve,
    };
  });
}

async function observePublication(
  ctx: ReleaseContext,
  deadlineAt?: number,
): Promise<PublicationWatchSnapshot> {
  const { state } = ctx;
  const parentId = state.publish.publishRunId;
  const dispatchedAt = state.publish.dispatchedAt;
  if (!parentId || !dispatchedAt || !state.validate.toolingTag || !state.validate.toolingSha) {
    throw new ReleaseRefusal("Retained state has no dispatched publication to watch.", [
      shellCommand("pnpm", ["release:stable", state.release, "--status"]),
    ]);
  }
  const parentRun = await readRun(ctx, parentId, deadlineAt);
  requireParentIdentity(state, parentRun);
  const parent = runObservation(parentRun, parentId);
  const candidates = await listOwnedChildren(ctx, state, parent, dispatchedAt, deadlineAt);
  const children: RunObservation[] = [];
  for (const candidate of candidates) {
    const candidateId = String(candidate.id);
    const child = await readRun(ctx, candidateId, deadlineAt);
    if (!isOwnedChild(state, parent, child)) {
      throw new Error(`Publication child ${candidateId} identity changed while observing it.`);
    }
    children.push(runObservation(child, candidateId));
  }
  children.sort((a, b) => Number(a.id) - Number(b.id));
  if (parent.status === "completed" && parent.conclusion === "success") {
    const hasPluginNpm = children.some(
      (run) => run.workflow === ".github/workflows/plugin-npm-release.yml",
    );
    if (!hasPluginNpm) {
      throw new Error("Completed publish parent has no observable plugin npm child.");
    }
  }
  const pendingApprovals: ApprovalObservation[] = [];
  for (const run of [parent, ...children]) {
    pendingApprovals.push(...(await readPendingApprovals(ctx, run, deadlineAt)));
  }
  const finalCandidates = await listOwnedChildren(ctx, state, parent, dispatchedAt, deadlineAt);
  if (
    finalCandidates.map((run) => run.id).join(",") !== candidates.map((run) => run.id).join(",")
  ) {
    throw new PublicationSnapshotChanged("Publication child inventory changed while observing it.");
  }
  const finalParentRun = await readRun(ctx, parentId, deadlineAt);
  requireParentIdentity(state, finalParentRun);
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
    (run) => run.status === "completed" && run.conclusion !== null && run.conclusion !== "success",
  );
  const attention = pendingApprovals.length > 0 || failedRuns.length > 0;
  const success =
    !attention &&
    parent.status === "completed" &&
    parent.conclusion === "success" &&
    children.every((run) => run.status === "completed" && run.conclusion === "success");
  return {
    contractVersion: 1,
    observedAt: new Date().toISOString(),
    release: state.release,
    repository: state.repo,
    state: attention ? "attention" : success ? "success" : "active",
    parent,
    children,
    pendingApprovals,
    failedRuns,
  };
}

function printSnapshot(snapshot: PublicationWatchSnapshot, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot));
    return;
  }
  console.log(
    `[release-watch] ${snapshot.release}: ${snapshot.state}; parent=${snapshot.parent.status}/${snapshot.parent.conclusion ?? "none"}; children=${snapshot.children.length}; approvals=${snapshot.pendingApprovals.length}; failures=${snapshot.failedRuns.length}`,
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
}

export async function watchPublication(
  ctx: ReleaseContext,
  options: WatchOptions,
): Promise<PublicationWatchSnapshot> {
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const timeout = () =>
    new ReleaseRefusal("Publication watcher timed out while the release was still active.", [
      shellCommand("pnpm", [
        "release:stable",
        ctx.state.release,
        "--watch",
        "--state-dir",
        ctx.options.stateDir,
      ]),
    ]);
  const waitForNextRead = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timeout();
    }
    await delay(Math.min(options.pollSeconds * 1_000, remaining));
  };
  let previous = "";
  let first = true;
  while (true) {
    if (!first && Date.now() >= deadline) {
      throw timeout();
    }
    first = false;
    let snapshot: PublicationWatchSnapshot;
    try {
      snapshot = await observePublication(ctx, deadline);
    } catch (error) {
      if (error instanceof PublicationDeadlineExceeded) {
        throw timeout();
      }
      if (!(error instanceof PublicationSnapshotChanged) || options.once) {
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
