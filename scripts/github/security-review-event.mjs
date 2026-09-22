#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import {
  createGitHubApi,
  parseApprovalCommands,
  publishGuardStatus,
  readSecurityReviewHistory,
  withSecurityReviewRecovery,
} from "./guard-shared.mjs";

const shaPattern = /^[a-f0-9]{40}$/u;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function reviewable(pullRequest, repository, defaultBranch) {
  return (
    positiveInteger(pullRequest.number) &&
    pullRequest.state === "open" &&
    pullRequest.draft === false &&
    pullRequest.base?.repo?.full_name === repository &&
    pullRequest.base?.ref === defaultBranch &&
    shaPattern.test(pullRequest.head?.sha ?? "")
  );
}

async function associatedPullRequests(api, prefix, sha) {
  try {
    return await api.paginate(`${prefix}/commits/${sha}/pulls`);
  } catch (error) {
    if (error?.status !== 404 && error?.status !== 422) {
      throw error;
    }
    return [];
  }
}

async function selectRunPullRequests(api, prefix, run, repository, defaultBranch) {
  let candidates = run.pull_requests;
  if (!Array.isArray(candidates)) {
    throw new Error("CI workflow response has no pull request association list.");
  }
  if (candidates.length === 0) {
    candidates = await associatedPullRequests(api, prefix, run.head_sha);
    // Fork run associations can be empty and the commit can be unavailable in
    // the base repository. Query only the run's branch, never the PR backlog.
    if (candidates.length === 0) {
      const owner = run.head_repository?.owner?.login;
      if (!owner || !run.head_branch) {
        throw new Error("CI workflow response has no source branch identity.");
      }
      candidates = await api.paginate(
        `${prefix}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}`,
      );
    }
  }
  const selected = new Map();
  for (const candidate of candidates) {
    if (!positiveInteger(candidate.number)) {
      throw new Error("CI workflow association contains an invalid pull request number.");
    }
    const pullRequest = await api.request(`${prefix}/pulls/${candidate.number}`);
    if (
      reviewable(pullRequest, repository, defaultBranch) &&
      pullRequest.head.sha === run.head_sha &&
      positiveInteger(run.head_repository?.id) &&
      pullRequest.head.repo?.id === run.head_repository.id &&
      pullRequest.head.ref === run.head_branch
    ) {
      selected.set(pullRequest.number, { pr: pullRequest.number, head: pullRequest.head.sha });
    }
  }
  return selected;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error("CI reconciliation response has an invalid timestamp.");
  }
  return parsed;
}

async function reconcileCompletedRuns(api, prefix, repository, defaultBranch) {
  const now = Date.now();
  const hour = 60 * 60 * 1_000;
  const previous = await api.request(
    `${prefix}/actions/workflows/security-review.yml/runs?event=schedule&status=success&per_page=1`,
  );
  if (!Array.isArray(previous.workflow_runs)) {
    throw new Error("Security review workflow response has no workflow run list.");
  }
  const previousStart = Date.parse(previous.workflow_runs[0]?.created_at);
  const lowerBound = Math.max(
    Number.isNaN(previousStart) ? now - hour : previousStart,
    now - 6 * hour,
  );
  const upperBound = now - 5 * 60 * 1_000;
  const createdSince = lowerBound - 6 * hour;
  const created = encodeURIComponent(`>=${new Date(createdSince).toISOString()}`);
  const runsByHead = new Map();
  for (let page = 1; page <= 3; page += 1) {
    const response = await api.request(
      `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=${created}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error("CI workflow response has no workflow run list.");
    }
    let allOlder = true;
    for (const run of response.workflow_runs) {
      if (!positiveInteger(run.id)) {
        throw new Error("CI event has no valid workflow run identifier.");
      }
      if (
        run.path !== ".github/workflows/ci.yml" ||
        run.repository?.full_name !== repository ||
        !shaPattern.test(run.head_sha ?? "")
      ) {
        throw new Error("CI completion does not match the repository's CI workflow.");
      }
      const createdAt = timestamp(run.created_at);
      const updatedAt = timestamp(run.updated_at);
      if (createdAt >= createdSince) {
        allOlder = false;
      }
      if (
        run.status === "completed" &&
        run.conclusion !== "skipped" &&
        updatedAt >= lowerBound &&
        updatedAt <= upperBound &&
        (!runsByHead.has(run.head_sha) || run.id > runsByHead.get(run.head_sha).id)
      ) {
        runsByHead.set(run.head_sha, run);
      }
    }
    if (response.workflow_runs.length < 100 || allOlder) {
      break;
    }
  }
  const selected = new Map();
  for (const run of runsByHead.values()) {
    const combined = await api.request(`${prefix}/commits/${run.head_sha}/status`);
    if (!Array.isArray(combined.statuses)) {
      throw new Error("Commit status response has no status list.");
    }
    const status = combined.statuses.find(
      (entry) =>
        typeof entry.context === "string" && entry.context.toLowerCase() === "openclaw/ci-gate",
    );
    // A review that remains pending publishes a newer status, stopping reselection.
    if (
      status &&
      (status.state !== "pending" || timestamp(status.created_at) >= timestamp(run.updated_at))
    ) {
      continue;
    }
    for (const [number, entry] of await selectRunPullRequests(
      api,
      prefix,
      run,
      repository,
      defaultBranch,
    )) {
      if (!selected.has(number)) {
        selected.set(number, entry);
      }
    }
  }
  return [...selected.values()].toSorted((left, right) => left.pr - right.pr);
}

async function resolvePullRequests(api, event, eventName, repository) {
  const defaultBranch = event.repository?.default_branch;
  if (!defaultBranch || event.repository?.full_name !== repository) {
    throw new Error("Security review event does not identify the expected repository.");
  }
  const prefix = `/repos/${repository}`;
  if (eventName === "pull_request_target" || eventName === "issue_comment") {
    if (
      eventName === "issue_comment" &&
      (!event.issue?.pull_request ||
        !["created", "edited", "deleted"].includes(event.action) ||
        // An edit can remove the command entirely. Its previous body still
        // identifies a revocation; authorization always uses live comments.
        (parseApprovalCommands(event.comment?.body).length === 0 &&
          (event.action !== "edited" ||
            parseApprovalCommands(event.changes?.body?.from).length === 0)))
    ) {
      return [];
    }
    const number =
      eventName === "pull_request_target" ? event.pull_request?.number : event.issue?.number;
    if (!positiveInteger(number)) {
      throw new Error("Security review event has no valid pull request number.");
    }
    const pullRequest = await api.request(`${prefix}/pulls/${number}`);
    const selected = new Map(
      reviewable(pullRequest, repository, defaultBranch)
        ? [[number, { pr: number, head: pullRequest.head.sha }]]
        : [],
    );
    if (
      eventName === "pull_request_target" &&
      ["closed", "synchronize", "edited"].includes(event.action)
    ) {
      const heads = new Set([pullRequest.head?.sha]);
      if (event.action === "synchronize" && shaPattern.test(event.before ?? "")) {
        heads.add(event.before);
      }
      const currentPullRequests = new Map([[number, pullRequest]]);
      for (const sha of heads) {
        if (!shaPattern.test(sha ?? "")) {
          throw new Error("Pull request event has no valid head commit.");
        }
        // Statuses belong to commits. Closing a duplicate or moving it to a new
        // head must refresh the remaining PR without a manual guard run.
        const [owner, repo] = repository.split("/");
        for (const relatedNumber of (await readSecurityReviewHistory(api, owner, repo, sha))
          .pullRequestNumbers) {
          if (!currentPullRequests.has(relatedNumber)) {
            currentPullRequests.set(
              relatedNumber,
              await api.request(`${prefix}/pulls/${relatedNumber}`),
            );
          }
          const current = currentPullRequests.get(relatedNumber);
          if (reviewable(current, repository, defaultBranch) && current.head.sha === sha) {
            selected.set(current.number, { pr: current.number, head: current.head.sha });
          }
        }
      }
    }
    return [...selected.values()].toSorted((left, right) => left.pr - right.pr);
  }
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    return reconcileCompletedRuns(api, prefix, repository, defaultBranch);
  }
  if (eventName !== "workflow_run" || event.action !== "completed") {
    throw new Error("Security review requires an automatic pull request or CI event.");
  }
  const runId = event.workflow_run?.id;
  if (!positiveInteger(runId)) {
    throw new Error("CI event has no valid workflow run identifier.");
  }
  const run = await api.request(`${prefix}/actions/runs/${runId}`);
  const workflow = await api.request(`${prefix}/actions/workflows/ci.yml`);
  if (
    run.id !== runId ||
    !positiveInteger(workflow.id) ||
    run.workflow_id !== workflow.id ||
    workflow.path !== ".github/workflows/ci.yml" ||
    run.path !== workflow.path ||
    run.repository?.full_name !== repository ||
    !shaPattern.test(run.head_sha ?? "") ||
    run.head_sha !== event.workflow_run?.head_sha
  ) {
    throw new Error("CI completion does not match the repository's CI workflow.");
  }
  const exactHeadReleaseGate =
    run.event === "workflow_dispatch" && run.display_title === `CI release gate ${run.head_sha}`;
  if ((run.event !== "pull_request" && !exactHeadReleaseGate) || run.status !== "completed") {
    return [];
  }
  const selected = await selectRunPullRequests(api, prefix, run, repository, defaultBranch);
  return [...selected.values()].toSorted((left, right) => left.pr - right.pr);
}

async function main() {
  const {
    GITHUB_TOKEN,
    GITHUB_EVENT_PATH,
    GITHUB_EVENT_NAME,
    GITHUB_REPOSITORY,
    GITHUB_OUTPUT,
    GITHUB_RUN_ID,
  } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_EVENT_PATH || !GITHUB_EVENT_NAME || !GITHUB_REPOSITORY) {
    throw new Error("GitHub token, event, event name, and repository are required.");
  }
  const api = createGitHubApi(GITHUB_TOKEN, { userAgent: "openclaw-security-review-event" });
  const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
  const selected = await resolvePullRequests(api, event, GITHUB_EVENT_NAME, GITHUB_REPOSITORY);
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  for (const entry of selected) {
    // Record every PR before concurrency can replace its pending review job.
    await publishGuardStatus(
      {
        api,
        owner,
        repo,
        pullRequest: { number: entry.pr, head: { sha: entry.head } },
        context: "openclaw/ci-gate",
        runUrl: `https://github.com/${owner}/${repo}/actions/runs/${GITHUB_RUN_ID}`,
      },
      "pending",
      "Review scheduled; CI and security review have not completed",
    );
  }
  const matrix = JSON.stringify({ include: selected });
  if (GITHUB_OUTPUT) {
    await appendFile(GITHUB_OUTPUT, `matrix=${matrix}\nhas-prs=${selected.length > 0}\n`);
  }
  console.log(matrix);
}

withSecurityReviewRecovery(main).catch(
  /** @param {unknown} error */ (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
