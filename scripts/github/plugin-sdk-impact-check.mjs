#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evaluatePluginSdkImpact,
  extractOpenClawRfcPullNumbers,
  formatPluginSdkImpactFailure,
  pluginSdkImpactRequirements,
} from "./plugin-sdk-impact-policy.mjs";
import {
  DEFAULT_GITHUB_API_TIMEOUT_MS,
  isMaintainerTeamMember,
  readBoundedGitHubApiJson,
  withGitHubApiTimeout,
} from "./real-behavior-proof-policy.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A");
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubJson({ label, token, url, fetchImpl, timeoutMs }) {
  const response = await withGitHubApiTimeout(label, timeoutMs, (signal) =>
    fetchImpl(url, {
      headers: githubHeaders(token),
      signal,
    }),
  );
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}`);
  }
  return await withGitHubApiTimeout(`${label} response`, timeoutMs, (signal) =>
    readBoundedGitHubApiJson(response, `${label} response`, undefined, { signal }),
  );
}

async function fetchPagedGitHubJson({
  label,
  owner,
  repo,
  path,
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/${path}`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const pageItems = await fetchGitHubJson({
      fetchImpl,
      label: `${label} page ${page}`,
      timeoutMs,
      token,
      url,
    });
    items.push(...pageItems);
    if (!Array.isArray(pageItems) || pageItems.length < PAGE_SIZE) {
      return items;
    }
  }
  throw new Error(`${label} exceeded ${MAX_PAGES * PAGE_SIZE} items; failing closed.`);
}

/** Fetch changed files for the pull request being evaluated by the impact gate. */
export async function fetchPullRequestFiles(params) {
  return await fetchPagedGitHubJson({
    ...params,
    label: "pull request file lookup",
    path: `pulls/${params.pullNumber}/files`,
  });
}

/** Fetch pull request metadata when the triggering event only has an issue payload. */
export async function fetchPullRequest(params) {
  const url = new URL(
    `https://api.github.com/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}`,
  );
  return await fetchGitHubJson({
    ...params,
    fetchImpl: params.fetchImpl ?? fetch,
    label: "pull request lookup",
    timeoutMs: params.timeoutMs ?? DEFAULT_GITHUB_API_TIMEOUT_MS,
    url,
  });
}

/** Fetch issue comments so trusted ClawSweeper exact-head markers can be read. */
export async function fetchIssueComments(params) {
  return await fetchPagedGitHubJson({
    ...params,
    label: "issue comment lookup",
    path: `issues/${params.pullNumber}/comments`,
  });
}

/** Fetch pull request reviews used to verify current-head maintainer approval. */
export async function fetchPullRequestReviews(params) {
  return await fetchPagedGitHubJson({
    ...params,
    label: "pull request review lookup",
    path: `pulls/${params.pullNumber}/reviews`,
  });
}

const significantReviewStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function latestReviewsByLogin(reviews) {
  const byLogin = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    if (!login) {
      continue;
    }
    const state = String(review?.state ?? "").toUpperCase();
    if (!significantReviewStates.has(state)) {
      continue;
    }
    const previous = byLogin.get(login);
    const submittedAt = Date.parse(review.submitted_at ?? review.submittedAt ?? "") || 0;
    const previousSubmittedAt =
      Date.parse(previous?.submitted_at ?? previous?.submittedAt ?? "") || 0;
    if (!previous || submittedAt >= previousSubmittedAt) {
      byLogin.set(login, review);
    }
  }
  return byLogin;
}

/** Return true when an active maintainer approved the exact current PR head SHA. */
export async function hasMaintainerApprovalForHead({
  appToken,
  org,
  pullRequest,
  reviews,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
}) {
  const headSha = String(pullRequest?.head?.sha ?? pullRequest?.head_sha ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/iu.test(headSha)) {
    return false;
  }
  if (!appToken) {
    return false;
  }

  for (const [login, review] of latestReviewsByLogin(reviews)) {
    const state = String(review?.state ?? "").toUpperCase();
    const commitId = String(review?.commit_id ?? review?.commitId ?? "").toLowerCase();
    if (state !== "APPROVED" || commitId !== headSha) {
      continue;
    }
    if (
      await isMaintainerTeamMember({
        fetch: fetchImpl,
        login,
        org,
        timeoutMs,
        token: appToken,
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Return true when at least one linked openclaw/rfcs pull request is merged. */
export async function hasMergedRfcPullRequest({
  pullNumbers,
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
}) {
  for (const pullNumber of pullNumbers) {
    const url = new URL(`https://api.github.com/repos/openclaw/rfcs/pulls/${pullNumber}`);
    const body = await fetchGitHubJson({
      fetchImpl,
      label: `openclaw/rfcs pull ${pullNumber} lookup`,
      timeoutMs,
      token,
      url,
    });
    if (body?.merged_at || body?.mergedAt) {
      return true;
    }
  }
  return false;
}

function isMainModule() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

async function main(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("::error title=Plugin SDK impact gate failed::GITHUB_EVENT_PATH is not set.");
    process.exit(1);
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const repository = env.GITHUB_REPOSITORY;
  const [owner, repo] = String(repository ?? "").split("/");
  if (!repository || !owner || !repo) {
    console.error("::error title=Plugin SDK impact gate failed::GITHUB_REPOSITORY is missing.");
    process.exit(1);
  }
  const eventPullRequest = event.pull_request;
  const issuePullRequestNumber = event.issue?.pull_request ? event.issue.number : undefined;
  const pullRequestNumber = eventPullRequest?.number ?? issuePullRequestNumber;
  const pullRequest =
    eventPullRequest ??
    (pullRequestNumber
      ? await fetchPullRequest({
          owner,
          pullNumber: pullRequestNumber,
          repo,
          token: env.GH_APP_TOKEN || env.GITHUB_TOKEN,
        })
      : undefined);
  if (!pullRequest) {
    console.log("No pull_request payload found; skipping plugin SDK impact gate.");
    process.exit(0);
  }

  if (!pullRequest.number) {
    console.error(
      "::error title=Plugin SDK impact gate failed::GITHUB_REPOSITORY or PR number is missing.",
    );
    process.exit(1);
  }

  const token = env.GH_APP_TOKEN || env.GITHUB_TOKEN;
  const appToken = env.GH_APP_TOKEN;
  const commonParams = {
    owner,
    pullNumber: pullRequest.number,
    repo,
    token,
  };

  const [changedFiles, comments] = await Promise.all([
    fetchPullRequestFiles(commonParams),
    fetchIssueComments(commonParams),
  ]);
  const evaluation = evaluatePluginSdkImpact({
    changedFiles,
    comments,
    pullRequest,
  });
  if (!evaluation.applies) {
    console.log(evaluation.reason);
    process.exit(0);
  }

  const requirements = pluginSdkImpactRequirements(evaluation.classification);
  const rfcPullNumbers = extractOpenClawRfcPullNumbers(pullRequest.body ?? "");
  const [approvalPassed, rfcPassed] = await Promise.all([
    requirements.maintainerApproval
      ? fetchPullRequestReviews(commonParams).then((reviews) =>
          hasMaintainerApprovalForHead({
            appToken,
            fetchImpl: fetch,
            org: owner,
            pullRequest,
            reviews,
          }),
        )
      : Promise.resolve(true),
    requirements.rfc
      ? hasMergedRfcPullRequest({
          pullNumbers: rfcPullNumbers,
          token,
        })
      : Promise.resolve(true),
  ]);

  if (!evaluation.error && approvalPassed && rfcPassed) {
    console.log(
      `Plugin SDK impact gate passed: ${evaluation.classification} (${evaluation.classificationSource}).`,
    );
    process.exit(0);
  }

  const message = formatPluginSdkImpactFailure({
    approvalPassed,
    evaluation,
    rfcPassed,
    rfcPullNumbers,
  });
  console.error(`::error title=Plugin SDK impact gate required::${escapeCommandValue(message)}`);
  process.exit(1);
}

export const testing = {
  fetchIssueComments,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchPullRequestReviews,
  hasMaintainerApprovalForHead,
  hasMergedRfcPullRequest,
};

if (isMainModule()) {
  await main();
}
