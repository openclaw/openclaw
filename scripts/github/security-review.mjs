#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { reviewDependencyChanges } from "./dependency-guard.mjs";
import { assertGuardUnchanged, findMaintainerApproval, readGuardReview } from "./guard-review.mjs";
import {
  GitHubRateLimitError,
  publishGuardStatus,
  withGitHubRateLimitRecovery,
} from "./guard-shared.mjs";
import { securityReviewRollout } from "./security-review-rollout.mjs";
import { reviewSecuritySensitiveChanges } from "./security-sensitive-guard.mjs";

function ciRunState(run) {
  if (
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0
  ) {
    throw new Error("CI returned an invalid run identity.");
  }
  switch (run.status) {
    case "completed":
      return "completed";
    case "queued":
    case "in_progress":
    case "waiting":
    case "requested":
    case "pending":
      return "pending";
    default:
      throw new Error("CI returned an invalid run status.");
  }
}

async function ciState(review) {
  const { api, owner, repo, pullRequest } = review;
  const root = `/repos/${owner}/${repo}/actions`;
  const response = await api.request(
    `${root}/workflows/ci.yml/runs?head_sha=${pullRequest.head.sha}&per_page=100`,
  );
  if (!Array.isArray(response.workflow_runs) || response.total_count > 100) {
    throw new Error("Cannot identify the current CI run.");
  }
  // A same-named status alone must never stand in for absent or unfinished CI.
  // Use the latest real CI run, not arbitrary checks posted under its job name.
  const candidates = response.workflow_runs.filter(
    (candidate) =>
      (candidate.event === "pull_request" ||
        (candidate.event === "workflow_dispatch" &&
          candidate.display_title === `CI release gate ${pullRequest.head.sha}`)) &&
      candidate.path === ".github/workflows/ci.yml" &&
      candidate.head_sha === pullRequest.head.sha &&
      candidate.head_branch === pullRequest.head.ref &&
      candidate.repository?.id === pullRequest.base.repo.id,
  );
  // Invalid IDs make latest-run ordering untrustworthy, even if an older run passed.
  for (const candidate of candidates) {
    ciRunState(candidate);
  }
  const run = candidates.toSorted((left, right) => right.id - left.id)[0];
  if (!run || run.status !== "completed") {
    return "pending";
  }
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const result = await api.request(
      `${root}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count)) {
      throw new Error("CI returned an invalid job list.");
    }
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) {
      break;
    }
    if (result.jobs.length === 0 || page >= 100) {
      throw new Error("CI did not return the complete job list.");
    }
  }
  const current = await api.request(`${root}/runs/${run.id}`);
  const currentState = ciRunState(current);
  if (current.id !== run.id || current.head_sha !== run.head_sha) {
    throw new Error("The CI run identity changed during security review.");
  }
  if (currentState === "pending") {
    return "pending";
  }
  if (current.run_attempt !== run.run_attempt) {
    throw new Error("The completed CI attempt changed during security review; rerun this review.");
  }
  const gates = jobs.filter((job) => job.name === "openclaw/ci-gate");
  return gates.length === 1 && gates[0].status === "completed" && gates[0].conclusion === "success"
    ? "success"
    : "failure";
}

async function main() {
  const mode = process.env.OPENCLAW_SECURITY_REVIEW_MODE ?? "enforce";
  if (!["detect", "autoscrub", "enforce"].includes(mode)) {
    throw new Error(`Unknown security review mode: ${mode}`);
  }
  const review = await readGuardReview();
  if (!review) {
    return;
  }
  review.context = "openclaw/ci-gate";
  review.guards = [];
  await publishGuardStatus(review, "pending", "CI and security review have not completed");
  try {
    review.rollout = await securityReviewRollout(review);
    if (review.rollout.mode === "enforced") {
      if (mode !== "enforce") {
        await reviewDependencyChanges(review, mode);
        return;
      }
      // Each guard must publish its own notice even when its sibling rejects a PR.
      const errors = [];
      let allowed = true;
      for (const guard of [reviewDependencyChanges, reviewSecuritySensitiveChanges]) {
        try {
          if (!(await guard(review))) {
            allowed = false;
          }
        } catch (error) {
          if (error instanceof GitHubRateLimitError) {
            throw error;
          }
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
      if (!allowed) {
        await publishGuardStatus(
          review,
          "failure",
          "A maintainer must approve the current PR revision",
        );
        console.log("Security review is awaiting maintainer approval.");
        return;
      }
    } else {
      const summary = `Security review: ${review.rollout.mode}; standalone review statuses are not published.`;
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      } else {
        console.log(summary);
      }
      if (mode !== "enforce") {
        return;
      }
    }
    const ci = await ciState(review);
    if (ci === "pending") {
      await assertGuardUnchanged(review);
      await publishGuardStatus(review, "pending", "Waiting for CI; review updates automatically");
      console.log("Waiting for CI. CI completion will automatically reevaluate security review.");
      return;
    }
    if (ci === "failure") {
      await publishGuardStatus(
        review,
        "failure",
        "CI must complete successfully; review updates automatically",
      );
      console.log("The current CI gate did not pass. Review the CI workflow failures.");
      return;
    }
    // Authority can be removed while CI metadata and the other guard are read.
    // Revalidate both decisions immediately before publishing their combined result.
    for (const guard of review.guards) {
      if (guard.requiresApproval && !(await findMaintainerApproval(guard))) {
        await publishGuardStatus(
          guard,
          "failure",
          "A maintainer must approve the current PR revision",
        );
        await publishGuardStatus(
          review,
          "failure",
          "Maintainer approval changed during security review",
        );
        console.log("Maintainer approval changed during security review.");
        return;
      }
    }
    await assertGuardUnchanged(review);
    await publishGuardStatus(
      review,
      "success",
      "CI and applicable security review requirements passed",
    );
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      throw error;
    }
    await publishGuardStatus(
      review,
      "failure",
      "CI or security review failed; see workflow details",
    );
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withGitHubRateLimitRecovery(main).catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
