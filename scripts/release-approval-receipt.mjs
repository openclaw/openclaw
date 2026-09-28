#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  runReleaseToolingGh,
  validateReleasePublishParentRun,
} from "./release-tooling-identity.mjs";

const REPOSITORY = "openclaw/openclaw";
const PARENT_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const PARENT_APPROVAL_JOB = "Publish plugins, then OpenClaw";
const PARENT_RECEIPT_STEP = "Write release approval receipt";
const APPROVAL_ENVIRONMENT = "npm-release";
const MAX_RECEIPT_BYTES = 8 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const ID = /^[1-9][0-9]*$/u;
const RELEASE_TAG =
  /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const RECEIPT_KEYS =
  "version kind repository parentWorkflow parentRunId parentRunAttempt toolingRef toolingFullRef toolingSha releaseTag targetSha npmDistTag environment approvalJob approver".split(
    " ",
  );

function pattern(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function refIdentity(ref, fullRef, sha) {
  pattern(sha, SHA, "Workflow SHA");
  if (fullRef === "refs/heads/main" && ref === "main") {
    return;
  }
  if (
    !/^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(ref) ||
    fullRef !== `refs/tags/${ref}` ||
    !ref.startsWith(`release-publish/${sha.slice(0, 12)}-`)
  ) {
    throw new Error(
      "Release approval tooling must use main or an exact protected release-publish tag.",
    );
  }
}

function npmApprovals(approvals) {
  if (!Array.isArray(approvals)) {
    throw new Error("Release approval history must be an array.");
  }
  return approvals.filter(
    (entry) =>
      entry?.state === "approved" &&
      Array.isArray(entry.environments) &&
      entry.environments.some((environment) => environment?.name === APPROVAL_ENVIRONMENT),
  );
}

export function releaseApprovalArtifactName({ parentRunId, parentRunAttempt }) {
  pattern(parentRunId, ID, "Parent run id");
  pattern(parentRunAttempt, ID, "Parent run attempt");
  return `openclaw-release-approval-v1-${parentRunId}-${parentRunAttempt}`;
}

export function validateReleaseApprovalReceipt(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== RECEIPT_KEYS.length ||
    RECEIPT_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("Release approval receipt fields are invalid.");
  }
  if (value.version !== 1) {
    throw new Error("Release approval receipt version must be 1.");
  }
  for (const key of RECEIPT_KEYS.slice(1)) {
    if (typeof value[key] !== "string") {
      throw new Error(`Release approval receipt ${key} must be a string.`);
    }
  }
  for (const [key, expected] of Object.entries({
    kind: "openclaw-release-approval",
    repository: REPOSITORY,
    parentWorkflow: PARENT_WORKFLOW,
    environment: APPROVAL_ENVIRONMENT,
    approvalJob: PARENT_APPROVAL_JOB,
  })) {
    if (value[key] !== expected) {
      throw new Error(`Release approval receipt ${key} mismatch.`);
    }
  }
  for (const key of ["parentRunId", "parentRunAttempt"]) {
    pattern(value[key], ID, key);
  }
  refIdentity(value.toolingRef, value.toolingFullRef, value.toolingSha);
  pattern(value.releaseTag, RELEASE_TAG, "Release tag");
  pattern(value.targetSha, SHA, "Target SHA");
  if (!["latest", "beta", "alpha", "extended-stable"].includes(value.npmDistTag)) {
    throw new Error("Release approval npm dist-tag is invalid.");
  }
  if (
    typeof value.approver !== "string" ||
    !value.approver.trim() ||
    /\[bot\]$/iu.test(value.approver)
  ) {
    throw new Error("Release approval approver must be a human login.");
  }
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > MAX_RECEIPT_BYTES) {
    throw new Error("Release approval receipt exceeds 8 KiB.");
  }
  return value;
}

export function createReleaseApprovalReceipt(env, runGhJson = api) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Release approval requires workflow_dispatch.");
  }
  if (env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${PARENT_WORKFLOW}@${env.GITHUB_REF}`) {
    throw new Error("Release approval workflow ref does not match the executing parent.");
  }
  const parentRunId = pattern(env.GITHUB_RUN_ID, ID, "Parent run id");
  const approvals = npmApprovals(runGhJson(`actions/runs/${parentRunId}/approvals`));
  if (approvals.length === 0) {
    throw new Error("Release approval requires an approved npm-release environment entry.");
  }
  return validateReleaseApprovalReceipt({
    version: 1,
    kind: "openclaw-release-approval",
    repository: env.GITHUB_REPOSITORY,
    parentWorkflow: PARENT_WORKFLOW,
    parentRunId,
    parentRunAttempt: env.GITHUB_RUN_ATTEMPT,
    toolingRef: env.GITHUB_REF_NAME,
    toolingFullRef: env.GITHUB_REF,
    toolingSha: env.GITHUB_WORKFLOW_SHA,
    releaseTag: env.RELEASE_TAG,
    targetSha: env.TARGET_SHA,
    npmDistTag: env.RELEASE_NPM_DIST_TAG,
    environment: APPROVAL_ENVIRONMENT,
    approvalJob: PARENT_APPROVAL_JOB,
    approver: approvals.at(-1).user?.login,
  });
}

export function verifyReleaseApprovalReceipt({
  receipt,
  expected,
  parentRun,
  parentJobs,
  approvals,
  artifact,
}) {
  validateReleaseApprovalReceipt(receipt);
  for (const key of [
    "repository",
    "parentRunId",
    "parentRunAttempt",
    "toolingRef",
    "toolingFullRef",
    "toolingSha",
    ...["releaseTag", "targetSha", "npmDistTag"].filter((field) => expected[field] !== undefined),
  ]) {
    if (receipt[key] !== expected[key]) {
      throw new Error(`Release approval receipt ${key} does not match this publication.`);
    }
  }
  if (artifact?.name !== releaseApprovalArtifactName(receipt)) {
    throw new Error("Release approval artifact name mismatch.");
  }
  if (artifact.expired !== false) {
    throw new Error("Release approval artifact is expired.");
  }
  if (String(artifact.workflow_run?.id) !== receipt.parentRunId) {
    throw new Error("Release approval artifact parent run mismatch.");
  }
  if (artifact.workflow_run.head_sha !== receipt.toolingSha) {
    throw new Error("Release approval artifact tooling SHA mismatch.");
  }
  if (
    artifact.workflow_run.repository_id === undefined ||
    artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id
  ) {
    throw new Error("Release approval artifact repository mismatch.");
  }
  if (!Array.isArray(parentJobs?.jobs) || parentJobs.total_count !== parentJobs.jobs.length) {
    throw new Error("Release approval parent job inventory is incomplete.");
  }
  const jobs = parentJobs.jobs.filter((job) => job?.name === PARENT_APPROVAL_JOB);
  if (jobs.length !== 1) {
    throw new Error("Release approval parent job must be unique.");
  }
  const [job] = jobs;
  if (
    job.head_sha !== receipt.toolingSha ||
    String(job.run_id) !== receipt.parentRunId ||
    job.run_attempt !== Number(receipt.parentRunAttempt) ||
    !["in_progress", "completed"].includes(job.status)
  ) {
    throw new Error("Release approval parent job identity or status mismatch.");
  }
  const steps = job.steps?.filter((step) => step?.name === PARENT_RECEIPT_STEP);
  if (
    !Array.isArray(steps) ||
    steps.length !== 1 ||
    steps[0].status !== "completed" ||
    steps[0].conclusion !== "success"
  ) {
    throw new Error("Release approval receipt step did not complete successfully.");
  }
  if (!npmApprovals(approvals).some((entry) => entry.user?.login === receipt.approver)) {
    throw new Error("Release approval approver is not in the approved npm-release history.");
  }
  validateReleasePublishParentRun({
    identity: { sha: receipt.toolingSha },
    releasePublishRef: receipt.toolingRef,
    releasePublishFullRef: receipt.toolingFullRef,
    releasePublishRunId: receipt.parentRunId,
    releasePublishRunAttempt: receipt.parentRunAttempt,
    repository: receipt.repository,
    releasePublishParentStatePolicy: expected.parentStatePolicy ?? "active",
    run: parentRun,
  });
  return receipt;
}

function api(path) {
  const raw = runReleaseToolingGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"]);
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
    throw new Error("GitHub metadata exceeds limit.");
  }
  return JSON.parse(raw);
}

async function readReleaseApprovalReceipt({ expected, token, runGhJson = api, fetchImpl }) {
  const name = releaseApprovalArtifactName(expected);
  const runPath = `actions/runs/${expected.parentRunId}/attempts/${expected.parentRunAttempt}`;
  const deadline = Date.now() + 5 * 60 * 1000;
  let listed;
  for (;;) {
    listed = runGhJson(`actions/runs/${expected.parentRunId}/artifacts?name=${name}&per_page=100`);
    if (listed.total_count !== 0 || listed.artifacts?.length !== 0) {
      break;
    }
    if (runGhJson(runPath).status !== "in_progress" || Date.now() >= deadline) {
      throw new Error(
        "Release approval artifact is missing; parent is inactive or receipt wait timed out.",
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(10000, deadline - Date.now()));
    });
  }
  if (listed.total_count !== 1 || listed.artifacts?.length !== 1) {
    throw new Error("Exact release approval artifact is missing or ambiguous.");
  }
  const artifact = listed.artifacts[0];
  const maxArchiveBytes = MAX_RECEIPT_BYTES * 4;
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    expected: {
      repository: expected.repository,
      artifactId: artifact.id,
      artifactName: name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: Number(expected.parentRunId),
      workflowSha: expected.toolingSha,
    },
    token,
    fetchImpl,
    maxArchiveBytes,
    retryAttempts: 1,
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: ["approval.json"],
    maxArchiveBytes,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
    maxEntryBytes: () => MAX_RECEIPT_BYTES,
  });
  const receiptBytes = files.get("approval.json");
  const receipt = verifyReleaseApprovalReceipt({
    receipt: JSON.parse(receiptBytes.toString("utf8")),
    expected,
    parentRun: runGhJson(runPath),
    parentJobs: runGhJson(`${runPath}/jobs?per_page=100`),
    approvals: runGhJson(`actions/runs/${expected.parentRunId}/approvals`),
    artifact,
  });
  return { receipt, artifact, receiptBytes };
}

export async function downloadReleaseApprovalReceipt(params) {
  const { receipt, artifact } = await readReleaseApprovalReceipt(params);
  return { receipt, artifact };
}

// The parent authorizes ClawHub transactions only after plugin npm and the core
// approval; without the human gate the child must block here until that
// child-bound receipt exists, or ClawHub's publisher fails on a missing artifact.
export async function awaitClawHubParentAuthorization({
  parentRunId,
  parentRunAttempt,
  childRunId,
  childRunAttempt,
  toolingSha,
  runGhJson = api,
  sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  deadlineMs = 90 * 60 * 1000,
}) {
  pattern(toolingSha, SHA, "Tooling SHA");
  for (const [value, label] of [
    [parentRunId, "Parent run id"],
    [parentRunAttempt, "Parent run attempt"],
    [childRunId, "Child run id"],
    [childRunAttempt, "Child run attempt"],
  ]) {
    pattern(value, ID, label);
  }
  const name = `openclaw-clawhub-parent-authorization-v2-${parentRunId}-${parentRunAttempt}-${childRunId}-${childRunAttempt}`;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const listed = runGhJson(`actions/runs/${parentRunId}/artifacts?name=${name}&per_page=100`);
    const artifacts = Array.isArray(listed.artifacts) ? listed.artifacts : [];
    if (listed.total_count > 1 || artifacts.length > 1) {
      throw new Error(`ClawHub parent authorization ${name} is ambiguous.`);
    }
    const [artifact] = artifacts;
    if (artifact) {
      if (
        artifact.name !== name ||
        artifact.expired !== false ||
        String(artifact.workflow_run?.id) !== parentRunId ||
        artifact.workflow_run.head_sha !== toolingSha
      ) {
        throw new Error(`ClawHub parent authorization ${name} does not belong to the parent.`);
      }
      return artifact;
    }
    const run = runGhJson(`actions/runs/${parentRunId}/attempts/${parentRunAttempt}`);
    if (run.status !== "in_progress" || run.conclusion !== null) {
      throw new Error(
        `Release parent ${parentRunId}/${parentRunAttempt} is ${run.status}/${run.conclusion ?? "none"} without authorizing ClawHub transactions.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`ClawHub parent authorization ${name} did not appear before the deadline.`);
    }
    await sleep(Math.min(15000, deadline - Date.now()));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { output: { type: "string" } },
  });
  const env = process.env;
  if (positionals[0] === "wait-clawhub-authorization") {
    const artifact = await awaitClawHubParentAuthorization({
      parentRunId: env.RELEASE_PUBLISH_RUN_ID,
      parentRunAttempt: env.RELEASE_PUBLISH_RUN_ATTEMPT,
      childRunId: env.GITHUB_RUN_ID,
      childRunAttempt: env.GITHUB_RUN_ATTEMPT,
      toolingSha: env.EXPECTED_WORKFLOW_SHA,
    });
    console.log(`Release parent authorized ClawHub transactions: ${artifact.name}`);
    return;
  }
  if (!values.output || positionals.length !== 1) {
    throw new Error("Expected create, verify --output <path>, or wait-clawhub-authorization.");
  }
  let bytes;
  let output;
  let message;
  if (positionals[0] === "create") {
    const receipt = createReleaseApprovalReceipt(env);
    bytes = `${JSON.stringify(receipt)}\n`;
    output = `artifact_name=${releaseApprovalArtifactName(receipt)}\n`;
  } else if (positionals[0] === "verify") {
    const { receipt, artifact, receiptBytes } = await readReleaseApprovalReceipt({
      expected: {
        repository: env.GITHUB_REPOSITORY,
        parentRunId: env.RELEASE_PUBLISH_RUN_ID,
        parentRunAttempt: env.RELEASE_PUBLISH_RUN_ATTEMPT,
        toolingRef: env.EXPECTED_WORKFLOW_BRANCH,
        toolingFullRef: env.EXPECTED_WORKFLOW_FULL_REF,
        toolingSha: env.EXPECTED_WORKFLOW_SHA,
        ...(env.RELEASE_TAG ? { releaseTag: env.RELEASE_TAG } : {}),
        ...(env.RELEASE_TARGET_SHA ? { targetSha: env.RELEASE_TARGET_SHA } : {}),
        ...(env.RELEASE_NPM_DIST_TAG ? { npmDistTag: env.RELEASE_NPM_DIST_TAG } : {}),
        parentStatePolicy: env.RELEASE_PUBLISH_PARENT_STATE_POLICY || "active",
      },
      token: env.GH_TOKEN,
    });
    // Attestation verification must receive the downloaded bytes, including whitespace.
    bytes = receiptBytes;
    output = "parent_approval=receipt\n";
    message = `Verified release approval receipt ${artifact.name} approved by ${receipt.approver}`;
  } else {
    throw new Error("Expected create or verify.");
  }
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(values.output, bytes, { flag: "wx" });
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, output);
  }
  if (message) {
    console.log(message);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
