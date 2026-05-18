#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
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

const token = process.env.GH_APP_TOKEN;
const org = event.repository?.owner?.login;
const authorLogin = pullRequest.user?.login;
if (token && org && authorLogin) {
  try {
    if (await isMaintainerTeamMember({ token, org, login: authorLogin })) {
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

const message = `${evaluation.reason} Add after-fix evidence from a real OpenClaw setup in the PR body. Screenshots, recordings, terminal screenshots, console output, redacted runtime logs, linked artifacts, or copied live output count. Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. A maintainer can apply proof: override when appropriate.`;
console.error(`::error title=Real behavior proof required::${escapeCommandValue(message)}`);
process.exit(1);
