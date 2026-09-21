import { readFile } from "node:fs/promises";
import { createGitHubApi, parseApprovalCommands, publishGuardStatus } from "./guard-shared.mjs";
import { securityReviewRollout } from "./security-review-rollout.mjs";

const requestMarker = "<!-- openclaw:approval-request ";

function pullRequestNumber(event) {
  if (event.pull_request) {
    return event.pull_request.number;
  }
  if (event.issue?.pull_request && event.comment) {
    return event.issue.number;
  }
  return null;
}

function snapshot(pr) {
  // Approval binds to the PR head and target branch. Unrelated pushes to the
  // target move base.sha without a PR event, so they must not strand this check.
  return JSON.stringify([
    pr.number,
    pr.state,
    pr.created_at,
    pr.draft,
    pr.user?.id,
    pr.user?.login,
    pr.user?.type,
    pr.base?.repo?.id,
    pr.base?.ref,
    pr.head?.repo?.id,
    pr.head?.ref,
    pr.head?.sha,
    pr.maintainer_can_modify,
    pr.changed_files,
  ]);
}

export async function assertGuardUnchanged(guard) {
  const current = await guard.api.request(guard.pullPath);
  if (snapshot(current) !== snapshot(guard.pullRequest)) {
    throw new Error(
      "The pull request changed during security review; the next automatic event will evaluate it.",
    );
  }
  return current;
}

export async function readGuardReview() {
  const { GITHUB_TOKEN, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_EVENT_PATH || !GITHUB_REPOSITORY) {
    throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.");
  }
  const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
  // Only the trusted workflow resolver supplies this value, including CI completion events.
  const selected = process.env.OPENCLAW_SECURITY_REVIEW_PR_NUMBER;
  const number =
    selected === undefined
      ? pullRequestNumber(event)
      : /^[1-9][0-9]*$/u.test(selected)
        ? Number(selected)
        : null;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("No valid pull request in the guard event.");
  }
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const api = createGitHubApi(GITHUB_TOKEN, { userAgent: "openclaw-security-review" });
  const pullPath = `/repos/${owner}/${repo}/pulls/${number}`;
  const pullRequest = await api.request(pullPath);
  const expectedHead = process.env.OPENCLAW_SECURITY_REVIEW_HEAD_SHA;
  if (expectedHead !== undefined && expectedHead !== pullRequest.head?.sha) {
    throw new Error(
      "The PR head changed after scheduling; its next automatic event will evaluate it.",
    );
  }
  if (pullRequest.state !== "open" || pullRequest.draft) {
    return null;
  }
  return {
    api,
    owner,
    repo,
    event,
    pullRequest,
    pullPath,
    issuePath: `/repos/${owner}/${repo}/issues/${number}`,
    runUrl: `https://github.com/${owner}/${repo}/actions/runs/${GITHUB_RUN_ID}`,
  };
}

export async function openGuard({ context, commentMarker, approvalCommand }, prepared) {
  const review = prepared ?? (await readGuardReview());
  if (!review) {
    return null;
  }
  const guard = { ...review, context, commentMarker, approvalCommand };
  let rollout;
  try {
    rollout = review.rollout ?? (await securityReviewRollout(review));
  } catch (error) {
    await publishGuardStatus(guard, "failure", "Security review policy could not be evaluated");
    throw error;
  }
  if (rollout.mode !== "enforced") {
    console.log(`Security review: ${rollout.mode}.`);
    return null;
  }
  // Invalidate previous approval before any fallible file or authority reads.
  await publishGuardStatus(guard, "failure", "Security review has not completed");
  review.files ??= await guard.api.paginate(`${guard.pullPath}/files`);
  if (review.files.length !== guard.pullRequest.changed_files) {
    throw new Error(
      "GitHub did not return the complete changed-file list. Split the PR and retry.",
    );
  }
  await assertGuardUnchanged(guard);
  guard.files = review.files;
  review.guards?.push(guard);
  return guard;
}

async function maintainerRole(guard, user) {
  if (user?.type !== "User" || !user.login) {
    return null;
  }
  let permission;
  try {
    permission = await guard.api.request(
      `/repos/${guard.owner}/${guard.repo}/collaborators/${encodeURIComponent(user.login)}/permission`,
    );
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
  return permission.role_name === "maintain" || permission.role_name === "admin"
    ? permission.role_name
    : null;
}

function approvalRequest(guard, comments) {
  const current = { head: guard.pullRequest.head.sha, base: guard.pullRequest.base.ref };
  const notice = comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      comment.user.login === "github-actions[bot]" &&
      comment.body?.startsWith(`${guard.commentMarker}\n`),
  );
  const line = notice?.body?.split("\n")[1];
  if (!line?.startsWith(requestMarker) || !line.endsWith(" -->")) {
    return current;
  }
  let recorded;
  try {
    recorded = JSON.parse(line.slice(requestMarker.length, -4));
  } catch {
    return current;
  }
  if (recorded?.head !== current.head || recorded?.base !== current.base) {
    return current;
  }
  // The first notice for a revision has no timestamp. On the next evaluation,
  // freeze GitHub's update time before rewriting the sticky notice. A queued
  // comment can never be rebound to a head first observed after it was posted.
  const requestedAt = recorded.requestedAt ?? notice.updated_at;
  const since = Date.parse(requestedAt);
  const updatedAt = Date.parse(notice.updated_at);
  if (!Number.isFinite(since) || !Number.isFinite(updatedAt) || since > updatedAt) {
    return current;
  }
  return { ...current, requestedAt };
}

export function withApprovalRequest(guard, body) {
  if (!guard.approvalRequest) {
    return body;
  }
  const record = JSON.stringify(guard.approvalRequest)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `${guard.commentMarker}\n${requestMarker}${record} -->${body.slice(guard.commentMarker.length)}`;
}

export async function findMaintainerApproval(guard) {
  const { pullRequest } = guard;
  const sha = pullRequest.head.sha;
  const authorRole = await maintainerRole(guard, pullRequest.user);
  if (authorRole) {
    return { kind: "author", login: pullRequest.user.login, role: authorRole, sha };
  }
  const comments = await guard.api.paginate(`${guard.issuePath}/comments`);
  guard.approvalRequest = approvalRequest(guard, comments);
  const since = Date.parse(guard.approvalRequest.requestedAt);
  if (!Number.isFinite(since)) {
    return null;
  }
  for (const comment of comments.toReversed()) {
    if (
      !parseApprovalCommands(comment.body).includes(guard.approvalCommand) ||
      !(Date.parse(comment.created_at) > since) ||
      comment.updated_at !== comment.created_at ||
      comment.user?.id === pullRequest.user.id
    ) {
      continue;
    }
    const role = await maintainerRole(guard, comment.user);
    if (role) {
      return { kind: "comment", login: comment.user.login, role, sha, url: comment.html_url };
    }
  }
  return null;
}

export async function finishGuard(guard, { description, requiresApproval = false }) {
  guard.requiresApproval = requiresApproval;
  const approval = requiresApproval ? await findMaintainerApproval(guard) : null;
  await assertGuardUnchanged(guard);
  const allowed = !requiresApproval || approval !== null;
  await publishGuardStatus(
    guard,
    allowed ? "success" : "failure",
    allowed ? description : "A maintainer must approve the current PR revision",
  );
  guard.approval = approval;
  return allowed;
}
