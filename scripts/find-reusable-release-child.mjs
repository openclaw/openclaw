#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { releaseChildSpec } from "./full-release-validation-policy.mjs";
import {
  releaseChildDispatchInputs,
  releaseChildReuseSha256,
} from "./lib/full-release-child-request.mjs";
import { discoverReusableReleaseChild } from "./lib/full-release-child-reuse.mjs";
import { isWaived } from "./lib/release-validation-waivers.mjs";

const [workflow, ...args] = process.argv.slice(2);
const kind = process.env.CHILD_WORKFLOW_KIND;
const role = {
  ci: "normalCi",
  "plugin-prerelease":
    process.env.PHASE === "candidate" ? "pluginPrereleaseCandidate" : "pluginPrereleaseIndependent",
  "release-checks":
    process.env.PHASE === "candidate" ? "releaseChecksCandidate" : "releaseChecksIndependent",
  "npm-telegram": "npmTelegram",
  performance: "productPerformance",
}[kind];

if (args[0] === "--waiver-only") {
  if (releaseChildSpec(role).workflow !== workflow) {
    throw new Error("Child workflow differs from its release role");
  }
  const waived = isWaived({
    childRole: role,
    targetSha: process.env.TARGET_SHA,
    targetVersion: process.env.TARGET_VERSION,
  });
  if (waived) {
    console.log(`Waived ${workflow}; no child run is required.`);
  }
  process.exit(waived ? 0 : 3);
}

let selection;
try {
  if (releaseChildSpec(role).workflow !== workflow) {
    throw new Error("Child workflow differs from its release role");
  }
  // The P verifier evaluates immutable current-Q waiver data; dispatch inputs
  // still come from the frozen Q workflow.
  const sourcePath = process.env.CHILD_WORKFLOW_DIRECTORY
    ? resolve(process.env.CHILD_WORKFLOW_DIRECTORY, workflow)
    : new URL(`../.github/workflows/${workflow}`, import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  selection = await discoverReusableReleaseChild({
    repository: process.env.GITHUB_REPOSITORY,
    targetSha: process.env.TARGET_SHA,
    policyTargetVersion: process.env.TARGET_VERSION,
    workflowSha: process.env.PARENT_WORKFLOW_SHA,
    role,
    inputs: releaseChildDispatchInputs(source, args),
    excludeRunId: process.env.GITHUB_RUN_ID,
  });
} catch (error) {
  console.error(`Child reuse unavailable; dispatching fresh work: ${error.message}`);
}
if (selection) {
  const json = JSON.stringify(selection);
  // This current-parent witness binds the intended inputs and adopted receipt to
  // the later execution plan, independently of the prior parent's outcome.
  console.log(`FRV_CHILD_REUSE_SHA256=${releaseChildReuseSha256(selection)}`);
  console.log(`Reused ${workflow}: ${selection.url} (attempt 1)`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `run_id=${selection.runId}\nrun_attempt=1\nurl=${selection.url}\nchild_reuse=${json}\n`,
  );
} else {
  // Only this exit code means a normal miss; callers still dispatch fresh work.
  process.exitCode = 3;
}
