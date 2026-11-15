import { loadSecurityReviewPolicy } from "./security-review-policy.mjs";

function invalid(message) {
  throw new Error(`Cannot determine security review rollout: ${message}`);
}

function timestamp(value, name) {
  const parsed = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().replace(".000Z", "Z") !== value
  ) {
    invalid(`${name} is not a valid GitHub timestamp`);
  }
  return parsed;
}

function sha(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    invalid(`${name} is not a complete commit SHA`);
  }
  return value;
}

/** @returns {Promise<{ mode: "inactive" | "grandfathered" | "enforced" }>} */
export async function securityReviewRollout({ api, owner, repo, pullRequest }) {
  const { rolloutPullRequest } = loadSecurityReviewPolicy();
  if (rolloutPullRequest === undefined) {
    return { mode: "enforced" };
  }
  const rollout = await api.request(`/repos/${owner}/${repo}/pulls/${rolloutPullRequest}`);
  if (
    rollout?.number !== rolloutPullRequest ||
    rollout.base?.ref !== "main" ||
    rollout.base?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
    !["open", "closed"].includes(rollout.state)
  ) {
    invalid("the configured pull request does not identify this repository's main branch");
  }
  if (rollout.merged === false && rollout.merged_at === null) {
    return { mode: "inactive" };
  }
  if (rollout.merged !== true || rollout.state !== "closed") {
    invalid("the configured pull request has inconsistent merge metadata");
  }
  const mergedAt = timestamp(rollout.merged_at, "rollout merged_at");
  // Before merge GitHub reports a synthetic test merge here. After merge this
  // identifies the landed commit for merge, squash, and rebase methods.
  const mergeCommit = sha(rollout.merge_commit_sha, "rollout merge_commit_sha");
  const createdAt = timestamp(pullRequest.created_at, "pull request created_at");
  const head = sha(pullRequest.head?.sha, "pull request head");
  if (createdAt >= mergedAt || head === mergeCommit) {
    return { mode: "enforced" };
  }

  // File patches are returned only on the first comparison page; this request
  // needs only ancestry, not the potentially large product diff.
  const comparison = await api.request(
    `/repos/${owner}/${repo}/compare/${mergeCommit}...${head}?per_page=1&page=2`,
  );
  if (comparison?.base_commit?.sha !== mergeCommit) {
    invalid("the comparison does not identify the rollout commit");
  }
  const ancestor = sha(comparison.merge_base_commit?.sha, "comparison merge base") === mergeCommit;
  const statuses = ancestor ? ["ahead", "identical"] : ["behind", "diverged"];
  if (!statuses.includes(comparison.status)) {
    invalid("the comparison has inconsistent ancestry metadata");
  }
  return { mode: ancestor ? "enforced" : "grandfathered" };
}
