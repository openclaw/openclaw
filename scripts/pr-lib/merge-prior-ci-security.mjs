import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  revalidatePublishedSecurityClearance,
  securityReviewContracts,
} from "../github/guard-review.mjs";
import { parseGithubResponse } from "./gh-api-preflight.mjs";
import { execPrGh } from "./github.mjs";

const oid = /^[a-f0-9]{40}$/u;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const workflowPath = ".github/workflows/security-review.yml";
const root = new URL("../../", import.meta.url);
function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Prior-CI security admission: ${message}`);
  }
}

function read(path) {
  let raw;
  try {
    raw = execPrGh(
      [
        "api",
        "--hostname",
        "github.com",
        path.replace(/^\//u, ""),
        "--include",
        "-H",
        "Cache-Control: max-age=0",
      ],
      { encoding: "utf8" },
      "plain",
    );
  } catch (error) {
    const response = parseGithubResponse(String(error?.stdout ?? ""));
    if (response.status === "404") {
      const missing = new Error("Security review metadata is unavailable");
      missing.status = 404;
      throw missing;
    }
    throw error;
  }
  const response = parseGithubResponse(raw);
  requireEvidence(
    response.status === "200" && response.body !== null && response.body !== undefined,
    "complete writer-observed metadata is required",
  );
  return response.body;
}

function pages(path, key, head) {
  const rows = [];
  let total;
  for (let page = 1; ; page += 1) {
    const result = read(`${path}?per_page=100&page=${page}`);
    requireEvidence(
      Array.isArray(result[key]) &&
        Number.isSafeInteger(result.total_count) &&
        result.total_count >= 0 &&
        (total === undefined || total === result.total_count) &&
        (head === undefined || result.sha === head),
      "incomplete publisher or status pagination",
    );
    total = result.total_count;
    rows.push(...result[key]);
    requireEvidence(
      rows.length <= total && page <= 100,
      "incomplete publisher or status pagination",
    );
    if (rows.length === total) {
      return rows;
    }
    requireEvidence(result[key].length > 0, "incomplete publisher or status pagination");
  }
}

function list(path) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const values = read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireEvidence(
      Array.isArray(values) && page <= 100,
      "incomplete security authority pagination",
    );
    rows.push(...values);
    if (values.length < 100) {
      return rows;
    }
  }
}

function latestStatuses(path) {
  // Only history carries creator identity. GitHub orders it newest first,
  // including earlier failures superseded by a current guard decision.
  const history = list(path);
  requireEvidence(
    history.every((status) => positiveInteger(status?.id) && typeof status.context === "string") &&
      new Set(history.map((status) => status.id)).size === history.length,
    "incomplete status history identities",
  );
  const latest = new Map();
  for (const status of history) {
    const context = status.context.toLowerCase();
    if (!latest.has(context)) {
      latest.set(context, status);
    }
  }
  return [...latest.values()];
}

function sourceFiles() {
  const workflow = parse(readFileSync(new URL(workflowPath, root), "utf8"));
  const primary = workflow?.jobs?.review?.steps?.find((step) => step.id === "checkout");
  const retry = workflow?.jobs?.review?.steps?.find((step) => step.id === "checkout_retry");
  for (const step of [primary, retry]) {
    requireEvidence(
      /^actions\/checkout@[a-f0-9]{40}$/u.test(step?.uses ?? "") &&
        step.with?.ref === undefined &&
        step.with?.repository === undefined &&
        step.with?.["sparse-checkout-cone-mode"] === false &&
        typeof step.with?.["sparse-checkout"] === "string",
      "unsupported protected publisher checkout",
    );
  }
  requireEvidence(
    primary.with["sparse-checkout"] === retry.with["sparse-checkout"],
    "publisher checkout sources differ",
  );
  const paths = primary.with["sparse-checkout"]
    .trim()
    .split(/\r?\n/u)
    .map((path) => path.trim().replace(/^\//u, ""));
  requireEvidence(
    paths.length > 0 &&
      new Set(paths).size === paths.length &&
      paths.every(
        (path) =>
          /^[A-Za-z0-9._/-]+$/u.test(path) &&
          path.split("/").every((part) => part && part !== "." && part !== ".."),
      ),
    "publisher sources must be explicit repository files",
  );
  return [workflowPath, ...paths];
}

function statusSnapshot(statuses) {
  requireEvidence(
    statuses.every((status) => positiveInteger(status?.id) && typeof status.context === "string") &&
      new Set(statuses.map((status) => status.context.toLowerCase())).size === statuses.length,
    "ambiguous latest status identities",
  );
  const contexts = new Set(
    Object.values(securityReviewContracts).map((contract) => contract.context),
  );
  return statuses
    .filter((status) => contexts.has(status.context))
    .map(({ id, context, state, description, target_url, creator, created_at, updated_at }) => ({
      id,
      context,
      state,
      description,
      target_url,
      creator: { id: creator?.id, login: creator?.login, type: creator?.type },
      created_at,
      updated_at,
    }))
    .toSorted((left, right) => left.context.localeCompare(right.context));
}

function publisherIdentity(run) {
  return JSON.stringify([
    run?.id,
    run?.run_attempt,
    run?.head_sha,
    run?.head_branch,
    run?.path,
    run?.event,
    run?.status,
    run?.conclusion,
    run?.repository?.id,
    run?.repository?.full_name,
    run?.head_repository?.id,
  ]);
}

export async function verifyPriorCiSecurity({
  repository,
  repositoryId,
  pr,
  head,
  main,
  statusId,
}) {
  const [owner, repo] = repository.split("/");
  const prefix = `/repos/${repository}`;
  const statusPath = `${prefix}/commits/${head}/statuses`;
  const statuses = latestStatuses(statusPath);
  const snapshot = statusSnapshot(statuses);
  const combined = statuses.find(
    (status) => status.id === statusId && status.context === "openclaw/ci-gate",
  );
  const runPrefix = `https://github.com/${repository}/actions/runs/`;
  const runId =
    typeof combined?.target_url === "string" && combined.target_url.startsWith(runPrefix)
      ? Number(combined.target_url.slice(runPrefix.length))
      : Number.NaN;
  requireEvidence(
    positiveInteger(runId) && combined.target_url === `${runPrefix}${runId}`,
    "combined status has no exact Security Review publisher",
  );
  const runPath = `${prefix}/actions/runs/${runId}`;
  const run = read(runPath);
  requireEvidence(
    run.id === runId &&
      positiveInteger(run.run_attempt) &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.path === workflowPath &&
      // Approval-command activity now arrives as a dispatch from repository
      // automation; issue_comment publishers predate that cutover and stay valid.
      ["workflow_run", "schedule", "issue_comment", "workflow_dispatch"].includes(run.event) &&
      (run.event !== "workflow_dispatch" ||
        (run.actor?.id === 41898282 &&
          run.actor?.login === "github-actions[bot]" &&
          run.actor?.type === "Bot")) &&
      run.head_branch === "main" &&
      oid.test(run.head_sha ?? "") &&
      run.repository?.id === repositoryId &&
      run.repository?.full_name === repository &&
      run.head_repository?.id === repositoryId,
    "successful protected Security Review publisher is required",
  );
  const attemptPath = `${runPath}/attempts/${run.run_attempt}`;
  const attempt = read(attemptPath);
  requireEvidence(
    publisherIdentity(attempt) === publisherIdentity(run),
    "publisher attempt identity changed",
  );
  const comparison = read(`${prefix}/compare/${run.head_sha}...${main}?per_page=1&page=2`);
  requireEvidence(
    comparison.base_commit?.sha === run.head_sha &&
      comparison.merge_base_commit?.sha === run.head_sha &&
      ["ahead", "identical"].includes(comparison.status),
    "publisher source is not on protected main",
  );
  const sources = [];
  for (const path of sourceFiles()) {
    const bytes = readFileSync(new URL(path, root));
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const source = read(`${prefix}/contents/${path}?ref=${run.head_sha}`);
    requireEvidence(
      source.type === "file" && source.path === path && source.sha === sha,
      `Security Review publisher source differs from the current owner: ${path}`,
    );
    sources.push({ path, sha });
  }
  const jobs = pages(`${attemptPath}/jobs`, "jobs");
  requireEvidence(
    new Set(jobs.map((job) => job.id)).size === jobs.length &&
      jobs.every(
        (job) =>
          positiveInteger(job.id) &&
          job.run_id === run.id &&
          job.head_sha === run.head_sha &&
          job.status === "completed",
      ),
    "incomplete Security Review job identities",
  );
  const matches = jobs.filter((job) => job.name === `review (${pr}, ${head})`);
  const steps = matches[0]?.steps?.filter((step) => step.name === "Enforce security review");
  requireEvidence(
    matches.length === 1 &&
      matches[0].conclusion === "success" &&
      Array.isArray(steps) &&
      steps.length === 1 &&
      steps[0].status === "completed" &&
      steps[0].conclusion === "success",
    "successful exact-head security enforcement is required",
  );
  const pullPath = `${prefix}/pulls/${pr}`;
  const pullRequest = read(pullPath);
  requireEvidence(
    pullRequest.number === pr &&
      pullRequest.head?.sha === head &&
      pullRequest.base?.ref === "main" &&
      pullRequest.base?.repo?.id === repositoryId,
    "security review PR identity changed",
  );
  const api = {
    request: async (path, options) => {
      requireEvidence(
        options === undefined && path.startsWith(`${prefix}/`),
        "security admission only reads this repository",
      );
      return read(path);
    },
    paginate: async (path) => {
      requireEvidence(
        path.startsWith(`${prefix}/`),
        "security admission only reads this repository",
      );
      return list(path);
    },
  };
  const proof = await revalidatePublishedSecurityClearance(
    { api, owner, repo, pullRequest, pullPath, issuePath: `${prefix}/issues/${pr}` },
    statuses,
    {
      url: combined.target_url,
      startedAt: steps[0].started_at,
      completedAt: steps[0].completed_at,
    },
  );
  const current = read(runPath);
  requireEvidence(
    publisherIdentity(current) === publisherIdentity(run) &&
      JSON.stringify(statusSnapshot(latestStatuses(statusPath))) === JSON.stringify(snapshot),
    "security publisher or current statuses changed during admission",
  );
  return {
    ...proof,
    runId,
    runAttempt: run.run_attempt,
    jobId: matches[0].id,
    sourceSha: run.head_sha,
    sources,
  };
}
