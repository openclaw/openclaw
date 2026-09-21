#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import {
  createGitHubApi,
  parseApprovalCommands,
  publishGuardStatus,
  readSecurityReviewHistory,
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
  if (eventName !== "workflow_run" || event.action !== "completed") {
    throw new Error("Security review requires an automatic pull request or CI event.");
  }
  const runId = event.workflow_run?.id;
  if (!positiveInteger(runId)) {
    throw new Error("CI event has no valid workflow run identifier.");
  }
  const [run, workflow] = await Promise.all([
    api.request(`${prefix}/actions/runs/${runId}`),
    api.request(`${prefix}/actions/workflows/ci.yml`),
  ]);
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

main().catch(
  /** @param {unknown} error */ (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
