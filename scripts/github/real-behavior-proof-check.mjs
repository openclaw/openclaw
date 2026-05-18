#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  evaluateClawSweeperExactHeadProof,
  evaluateRealBehaviorProof,
  isMaintainerTeamMember,
} from "./real-behavior-proof-policy.mjs";

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A");
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("::error title=Real behavior proof failed::GITHUB_EVENT_PATH is not set.");
  process.exit(1);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request;
if (!pullRequest) {
  console.log("No pull_request payload found; skipping real behavior proof gate.");
  process.exit(0);
}

const appToken = process.env.GH_APP_TOKEN;
const org = event.repository?.owner?.login;
const authorLogin = pullRequest.user?.login;
if (appToken && org && authorLogin) {
  try {
    if (await isMaintainerTeamMember({ token: appToken, org, login: authorLogin })) {
      console.log(
        `PR author @${authorLogin} is an active member of the ${org}/maintainer team; skipping real behavior proof gate.`,
      );
      process.exit(0);
    }
  } catch (error) {
    console.warn(
      `::warning title=Maintainer membership check failed::${escapeCommandValue(error?.message ?? String(error))}`,
    );
  }
}

const evaluation = evaluateRealBehaviorProof({ pullRequest });
if (evaluation.passed) {
  console.log(evaluation.reason);
  process.exit(0);
}

const token = appToken || process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (token && repository && pullRequest.number) {
  const [owner, repo] = repository.split("/");
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch PR comments for proof verdicts: ${response.status}`);
    }
    const pageComments = await response.json();
    comments.push(...pageComments);
    if (pageComments.length < 100) {
      break;
    }
  }

  const clawSweeperEvaluation = evaluateClawSweeperExactHeadProof({
    pullRequest,
    comments,
  });
  if (clawSweeperEvaluation.passed) {
    console.log(clawSweeperEvaluation.reason);
    process.exit(0);
  }
}

const message = `${evaluation.reason} Add after-fix evidence from a real OpenClaw setup in the PR body. Screenshots, recordings, terminal screenshots, console output, redacted runtime logs, linked artifacts, or copied live output count. Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. A maintainer can apply proof: override when appropriate.`;
console.error(`::error title=Real behavior proof required::${escapeCommandValue(message)}`);
process.exit(1);
