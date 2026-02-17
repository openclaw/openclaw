#!/usr/bin/env tsx
/**
 * SHA Discipline — ensures review state matches current PR head.
 *
 * - Waits for review check run on headSha
 * - Ignores stale summary comments tied to older SHAs
 * - Fails if latest review run is non-success or times out
 * - Requires reruns after each synchronize/push
 */

import { execSync } from "node:child_process";

interface CheckRun {
  status: string;
  conclusion: string | null;
  head_sha: string;
  name: string;
}

async function getCheckRuns(headSha: string, checkName: string): Promise<CheckRun[]> {
  try {
    const output = execSync(
      `gh api repos/{owner}/{repo}/commits/${headSha}/check-runs --jq '.check_runs[] | select(.name == "${checkName}") | {status, conclusion, head_sha: .head_sha, name}'`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReviewOnHead(
  headSha: string,
  checkName = "code-review-agent",
  timeoutMinutes = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  const pollIntervalMs = 30_000;

  console.log(`Waiting for ${checkName} on ${headSha} (timeout: ${timeoutMinutes}min)`);

  while (Date.now() < deadline) {
    const runs = await getCheckRuns(headSha, checkName);

    if (runs.length > 0) {
      const latest = runs[0];

      if (latest.status === "completed") {
        if (latest.conclusion === "success") {
          console.log(`Review passed for ${headSha}`);
          return;
        }
        throw new Error(`Review check '${checkName}' failed for ${headSha}: ${latest.conclusion}`);
      }

      console.log(`Review status: ${latest.status} — waiting...`);
    } else {
      console.log(`No check runs found yet for ${headSha} — waiting...`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Review timed out after ${timeoutMinutes} minutes for ${headSha}`);
}

export function isStaleReview(reviewSha: string, currentHeadSha: string): boolean {
  return reviewSha !== currentHeadSha;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const headSha =
    process.env.HEAD_SHA ?? execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const checkName = process.env.REVIEW_CHECK_NAME ?? "code-review-agent";
  const timeout = parseInt(process.env.REVIEW_TIMEOUT_MINUTES ?? "20", 10);

  try {
    await waitForReviewOnHead(headSha, checkName, timeout);
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

main();
