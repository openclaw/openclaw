#!/usr/bin/env tsx
/**
 * Single Rerun-Comment Writer with SHA Dedupe.
 *
 * When multiple workflows can request reruns, duplicate bot comments
 * and race conditions appear. This script is the canonical rerun
 * requester — exactly one writer, deduplicated by marker + sha.
 */

import { execSync } from "node:child_process";

const MARKER = "<!-- code-review-auto-rerun -->";

interface PRComment {
  id: number;
  body: string;
  user: { login: string };
}

function listPRComments(prNumber: number): PRComment[] {
  try {
    const output = execSync(
      `gh api repos/{owner}/{repo}/issues/${prNumber}/comments --jq '.[] | {id, body, user: {login: .user.login}}'`,
      { encoding: "utf-8" },
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function postComment(prNumber: number, body: string): void {
  execSync(`gh pr comment ${prNumber} --body '${body.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
  });
}

export function requestReviewRerun(
  headSha: string,
  prNumber: number,
  reviewAgentUsername: string,
): boolean {
  const trigger = `sha:${headSha}`;

  const comments = listPRComments(prNumber);
  const alreadyRequested = comments.some(
    (c) => c.body.includes(MARKER) && c.body.includes(trigger),
  );

  if (alreadyRequested) {
    console.log(`Rerun already requested for ${headSha} on PR #${prNumber}`);
    return false;
  }

  const body = [MARKER, `@${reviewAgentUsername} please re-review`, trigger].join("\n");

  postComment(prNumber, body);
  console.log(`Requested re-review for ${headSha} on PR #${prNumber}`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const headSha =
    process.env.HEAD_SHA ?? execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0", 10);
  const reviewAgent = process.env.REVIEW_AGENT_USERNAME ?? "greptile[bot]";

  if (!prNumber) {
    console.error("PR_NUMBER is required");
    process.exit(1);
  }

  requestReviewRerun(headSha, prNumber, reviewAgent);
}

main();
