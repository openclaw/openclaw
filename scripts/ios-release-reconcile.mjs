#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/ios-release.yml";
const ORIGINAL_WORKFLOW_PATH = ".github/workflows/ios-beta-release.yml";
const ORIGINAL_JOB_NAME = "Upload and record iOS beta";
const PLATFORM = "ios";
const GATEWAY_VERSION = "2026.9.2";
const APP_STORE_VERSION = "2026.9.20";
const CANDIDATE_SHA = "d69752a1c90715e74a36652b2e64c41e9409c5fd";
const CANDIDATE_PARENT_SHA = "d3f01d9851f46649c5cfbf7d8ccb3965b73bf8d3";
const CANDIDATE_TREE_SHA = "e3f07b8d0064bc38aafc29847c1faa542f6c6240";
const ORIGINAL_RUN_ID = "34419244851";
const ORIGINAL_JOB_ID = "102691169741";
const ORIGINAL_STARTED_AT = "2026-09-10T00:04:43Z";
const ORIGINAL_COMPLETED_AT = "2026-09-10T01:40:28Z";
const ORIGINAL_RECEIPT_DIGEST = "98b4ddf27f890b5263c81b2a00537161446757ebe9cb109b9c923b1591992e04";
const UPLOAD_LOG_DIGEST = "dd61760ccd733f7be78e1e5f162a59f6f18e7b4f806950cf080b53ce44f99bbd";
const TARGET_REF = "release/2026.9.2-mobile";
const BUILD_NUMBER = "1";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_ID = /^[1-9][0-9]*$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const ARTIFACT_DIGEST = /^[0-9a-f]{64}$/u;
const INTERNAL_TESTING_STATES = new Set(["IN_BETA_TESTING", "READY_FOR_BETA_TESTING"]);
const CANDIDATE_FILES = {
  "apps/android/Config/Version.properties": {
    blob: "4ca596d1a75b59ee2e483b89e01583b14dda3103",
    sha256: "94bb41004694671c3ddec604888ac7fbbed39138a4177027e17cd57c6bf29c1d",
  },
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt": {
    blob: "d58d36ed1e0fc065a0979e79e1820a0c3b463040",
    sha256: "6ad1729a931f40402ef74b98ec7a8eeb577e6820d73173d138e8cbb111af423f",
  },
  "apps/android/version.json": {
    blob: "e23736e482447ad9406af523d70eb71c6938251f",
    sha256: "058ee5457eab2874d355af95718c79d88a04878a24527c8f3e4ac520300abec1",
  },
  "apps/ios/CHANGELOG.md": {
    blob: "21704cd513620b4ffb0c5be7ecb7b4dfd6cb1ae3",
    sha256: "9cf7026c8afe25076ff54f459fed9db5c0fca54f801e3c8958f32ccdad79cd3a",
  },
  "apps/mobile/version.json": {
    blob: "84b723e9baae35cb630e0bff0a6f60b9a7f0e681",
    sha256: "442b18aed43b26ccae103e3dfbb5c05d86a26c494a92b37208e3d3c89cf1a4ca",
  },
};
const CANDIDATE_PATHS = Object.keys(CANDIDATE_FILES).toSorted();

const ORIGINAL_RECEIPT_KEYS = [
  "actor",
  "androidPhoneVersionCode",
  "androidVersionName",
  "androidWearVersionCode",
  "buildTimestamp",
  "gatewayVersion",
  "iosAppStoreVersion",
  "kind",
  "platform",
  "repository",
  "runAttempt",
  "runId",
  "schemaVersion",
  "targetRef",
  "targetSha",
  "triggeringActor",
  "workflowFullRef",
  "workflowPath",
  "workflowSha",
];

const STORE_KEYS = [
  "app",
  "build",
  "configuredGroupId",
  "groups",
  "kind",
  "observedAt",
  "readOnly",
  "schemaVersion",
  "upload",
];

const EVIDENCE_KEYS = [
  "actor",
  "appStoreVersion",
  "buildNumber",
  "candidate",
  "currentRunAttempt",
  "currentRunId",
  "currentWorkflowSha",
  "gatewayVersion",
  "kind",
  "observedAt",
  "originalActor",
  "originalJobCompletedAt",
  "originalJobId",
  "originalJobStartedAt",
  "originalReceiptArtifactId",
  "originalReceiptDigest",
  "originalRunId",
  "originalWorkflowSha",
  "repository",
  "schemaVersion",
  "store",
  "targetRef",
  "targetSha",
  "uploadLogDigest",
  "workflowPath",
];

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are invalid.`);
  }
}

function allowedKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${label} fields are invalid.`);
  }
}

function pattern(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label) {
  pattern(value, ISO_UTC, label);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    fail(`${label} is invalid.`);
  }
  return millis;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function readCanonicalJson(file, label, maxBytes = MAX_JSON_BYTES) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    fail(`${label} must be a bounded regular file.`);
  }
  if ((stat.mode & 0o022) !== 0) {
    fail(`${label} must not be group- or world-writable.`);
  }
  const bytes = readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(canonicalBytes(value))) {
    fail(`${label} is not canonical JSON.`);
  }
  return { bytes, digest: sha256(bytes), value };
}

function writeCanonicalJson(file, value) {
  writeFileSync(file, canonicalBytes(value), { mode: 0o600, flag: "wx" });
}

function gitOutput(repositoryRoot, args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: options.encoding === "buffer" ? null : (options.encoding ?? "utf8"),
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function exactJsonObject(bytes, keys, label) {
  const value = JSON.parse(bytes.toString("utf8"));
  exactKeys(value, keys, label);
  return value;
}

export function validateCandidateParity(repositoryRoot) {
  const stat = lstatSync(repositoryRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("Candidate repository must be a real directory.");
  }
  const root = realpathSync(repositoryRoot);
  if (process.env.GITHUB_WORKSPACE && root !== realpathSync(process.env.GITHUB_WORKSPACE)) {
    fail("Candidate repository must be the trusted workflow checkout.");
  }

  const commit = gitOutput(root, ["rev-parse", `${CANDIDATE_SHA}^{commit}`]).trim();
  const parent = gitOutput(root, ["rev-parse", `${CANDIDATE_SHA}^`]).trim();
  const tree = gitOutput(root, ["rev-parse", `${CANDIDATE_SHA}^{tree}`]).trim();
  if (commit !== CANDIDATE_SHA || parent !== CANDIDATE_PARENT_SHA || tree !== CANDIDATE_TREE_SHA) {
    fail("Frozen candidate commit identity mismatch.");
  }

  const changedPaths = gitOutput(root, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    CANDIDATE_PARENT_SHA,
    CANDIDATE_SHA,
  ])
    .split("\n")
    .filter(Boolean)
    .toSorted();
  if (
    changedPaths.length !== CANDIDATE_PATHS.length ||
    changedPaths.some((file, index) => file !== CANDIDATE_PATHS[index])
  ) {
    fail("Frozen candidate changed-path set mismatch.");
  }

  const blobs = {};
  for (const file of CANDIDATE_PATHS) {
    const expected = CANDIDATE_FILES[file];
    const blob = gitOutput(root, ["rev-parse", `${CANDIDATE_SHA}:${file}`]).trim();
    const bytes = gitOutput(root, ["show", `${CANDIDATE_SHA}:${file}`], {
      encoding: "buffer",
    });
    const digest = sha256(bytes);
    if (blob !== expected.blob || digest !== expected.sha256) {
      fail(`Frozen candidate file mismatch: ${file}.`);
    }
    blobs[file] = { blob, sha256: digest };
  }

  const mobileVersion = exactJsonObject(
    gitOutput(root, ["show", `${CANDIDATE_SHA}:apps/mobile/version.json`], {
      encoding: "buffer",
    }),
    ["version"],
    "Candidate mobile version",
  );
  const androidVersion = exactJsonObject(
    gitOutput(root, ["show", `${CANDIDATE_SHA}:apps/android/version.json`], {
      encoding: "buffer",
    }),
    ["version", "versionCode"],
    "Candidate Android version",
  );
  const packageJson = JSON.parse(gitOutput(root, ["show", `${CANDIDATE_SHA}:package.json`]));
  if (
    mobileVersion.version !== GATEWAY_VERSION ||
    androidVersion.version !== GATEWAY_VERSION ||
    androidVersion.versionCode !== 2026090201 ||
    packageJson?.version !== GATEWAY_VERSION ||
    `${mobileVersion.version}0` !== APP_STORE_VERSION
  ) {
    fail("Frozen candidate release version identity mismatch.");
  }

  return {
    appStoreRevision: 0,
    appStoreVersion: APP_STORE_VERSION,
    blobs,
    buildNumber: BUILD_NUMBER,
    changedPaths,
    commit,
    gatewayVersion: GATEWAY_VERSION,
    parent,
    tree,
  };
}

function validateCandidateEvidence(candidate) {
  exactKeys(
    candidate,
    [
      "appStoreRevision",
      "appStoreVersion",
      "blobs",
      "buildNumber",
      "changedPaths",
      "commit",
      "gatewayVersion",
      "parent",
      "tree",
    ],
    "Candidate evidence",
  );
  if (
    candidate.appStoreRevision !== 0 ||
    candidate.appStoreVersion !== APP_STORE_VERSION ||
    candidate.buildNumber !== BUILD_NUMBER ||
    candidate.commit !== CANDIDATE_SHA ||
    candidate.gatewayVersion !== GATEWAY_VERSION ||
    candidate.parent !== CANDIDATE_PARENT_SHA ||
    candidate.tree !== CANDIDATE_TREE_SHA ||
    !Array.isArray(candidate.changedPaths) ||
    candidate.changedPaths.length !== CANDIDATE_PATHS.length ||
    candidate.changedPaths.some((file, index) => file !== CANDIDATE_PATHS[index])
  ) {
    fail("Candidate evidence identity mismatch.");
  }
  exactKeys(candidate.blobs, CANDIDATE_PATHS, "Candidate blob evidence");
  for (const file of CANDIDATE_PATHS) {
    exactKeys(candidate.blobs[file], ["blob", "sha256"], `Candidate blob ${file}`);
    if (
      candidate.blobs[file].blob !== CANDIDATE_FILES[file].blob ||
      candidate.blobs[file].sha256 !== CANDIDATE_FILES[file].sha256
    ) {
      fail(`Candidate blob evidence mismatch: ${file}.`);
    }
  }
  return candidate;
}

export function validateOriginalReceipt(receipt, expected = {}) {
  exactKeys(receipt, ORIGINAL_RECEIPT_KEYS, "Original authority receipt");
  const fixed = {
    kind: "openclaw-mobile-release-authority",
    schemaVersion: 2,
    platform: PLATFORM,
    repository: REPOSITORY,
    runAttempt: 1,
    runId: ORIGINAL_RUN_ID,
    targetRef: TARGET_REF,
    targetSha: CANDIDATE_SHA,
    gatewayVersion: GATEWAY_VERSION,
    iosAppStoreVersion: APP_STORE_VERSION,
    workflowPath: ORIGINAL_WORKFLOW_PATH,
    workflowFullRef: `${REPOSITORY}/${ORIGINAL_WORKFLOW_PATH}@refs/heads/main`,
  };
  for (const [key, value] of Object.entries({ ...fixed, ...expected })) {
    if (receipt[key] !== value) {
      fail(`Original authority receipt ${key} mismatch.`);
    }
  }
  pattern(receipt.workflowSha, SHA, "Original workflow SHA");
  timestamp(receipt.buildTimestamp, "Original build timestamp");
  if (
    typeof receipt.actor !== "string" ||
    receipt.actor.length === 0 ||
    receipt.actor !== receipt.triggeringActor ||
    /\[bot\]$/iu.test(receipt.actor)
  ) {
    fail("Original authority actor is invalid.");
  }
  return receipt;
}

function groupRecord(group) {
  exactKeys(
    group,
    ["containsBuild", "hasAccessToAllBuilds", "id", "isInternalGroup"],
    "Store group",
  );
  pattern(group.id, RESOURCE_ID, "Store group ID");
  if (
    typeof group.containsBuild !== "boolean" ||
    typeof group.hasAccessToAllBuilds !== "boolean" ||
    typeof group.isInternalGroup !== "boolean"
  ) {
    fail("Store group flags are invalid.");
  }
  return group;
}

export function validateStoreObservation(observation, expected = {}) {
  exactKeys(observation, STORE_KEYS, "Store observation");
  if (
    observation.kind !== "openclaw-ios-release-store-observation" ||
    observation.schemaVersion !== 1 ||
    observation.readOnly !== true
  ) {
    fail("Store observation identity is invalid.");
  }
  timestamp(observation.observedAt, "Store observation timestamp");
  const configuredGroupId = pattern(
    expected.configuredGroupId ?? observation.configuredGroupId,
    RESOURCE_ID,
    "Configured group ID",
  );
  if (observation.configuredGroupId !== configuredGroupId) {
    fail("Configured group ID mismatch.");
  }

  exactKeys(observation.app, ["bundleId", "id"], "Store app");
  pattern(observation.app.id, POSITIVE_ID, "Store app ID");
  if (expected.appId !== undefined && observation.app.id !== expected.appId) {
    fail("Store app ID mismatch.");
  }
  if (typeof observation.app.bundleId !== "string" || observation.app.bundleId.length === 0) {
    fail("Store bundle ID is invalid.");
  }

  exactKeys(
    observation.upload,
    ["buildNumber", "id", "platform", "shortVersion", "state", "uploadedAt"],
    "Build upload",
  );
  pattern(observation.upload.id, RESOURCE_ID, "Build upload ID");
  if (
    observation.upload.platform !== "IOS" ||
    observation.upload.shortVersion !== APP_STORE_VERSION ||
    observation.upload.buildNumber !== BUILD_NUMBER
  ) {
    fail("Build upload identity mismatch.");
  }
  if (
    observation.upload.state === null ||
    typeof observation.upload.state !== "object" ||
    Array.isArray(observation.upload.state)
  ) {
    fail("Build upload state must be a complete StateDetail object.");
  }
  allowedKeys(
    observation.upload.state,
    ["errors", "infos", "state", "warnings"],
    "Build upload state",
  );
  if (observation.upload.state.state !== "COMPLETE") {
    fail("Build upload state must be a complete StateDetail object.");
  }
  for (const key of ["errors", "infos", "warnings"]) {
    if (!Object.hasOwn(observation.upload.state, key)) {
      continue;
    }
    const details = observation.upload.state[key];
    if (!Array.isArray(details)) {
      fail(`Build upload state ${key} must be an array when present.`);
    }
    for (const detail of details) {
      allowedKeys(detail, ["code", "description"], `Build upload state ${key} entry`);
      for (const field of ["code", "description"]) {
        if (Object.hasOwn(detail, field) && typeof detail[field] !== "string") {
          fail(`Build upload state ${key} entry ${field} must be a string when present.`);
        }
      }
    }
  }
  const uploadedAt = timestamp(observation.upload.uploadedAt, "Build upload timestamp");
  if (
    uploadedAt < timestamp(ORIGINAL_STARTED_AT, "Original job start") ||
    uploadedAt > timestamp(ORIGINAL_COMPLETED_AT, "Original job completion")
  ) {
    fail("Build upload timestamp is outside the original job interval.");
  }

  exactKeys(
    observation.build,
    [
      "appStoreVersion",
      "buildNumber",
      "expired",
      "id",
      "internalBuildState",
      "platform",
      "processingState",
    ],
    "TestFlight build",
  );
  pattern(observation.build.id, RESOURCE_ID, "TestFlight build ID");
  if (
    observation.build.platform !== "IOS" ||
    observation.build.appStoreVersion !== APP_STORE_VERSION ||
    observation.build.buildNumber !== BUILD_NUMBER ||
    observation.build.processingState !== "VALID" ||
    observation.build.expired !== false ||
    !INTERNAL_TESTING_STATES.has(observation.build.internalBuildState)
  ) {
    fail("TestFlight build is not the unique valid unexpired target.");
  }

  if (!Array.isArray(observation.groups) || observation.groups.length === 0) {
    fail("Store groups are incomplete.");
  }
  const groups = observation.groups.map(groupRecord);
  const ids = groups.map((group) => group.id);
  if (new Set(ids).size !== ids.length) {
    fail("Store group IDs must be unique.");
  }
  const targets = groups.filter((group) => group.id === configuredGroupId);
  if (
    targets.length !== 1 ||
    targets[0].isInternalGroup !== true ||
    targets[0].hasAccessToAllBuilds !== true ||
    targets[0].containsBuild !== true
  ) {
    fail("Configured automatic internal group does not contain the build.");
  }
  const assigned = groups.filter((group) => group.containsBuild).map((group) => group.id);
  if (assigned.length !== 1 || assigned[0] !== configuredGroupId) {
    fail("TestFlight build assignment is not exclusive to the configured group.");
  }
  const unsafeAutomatic = groups.filter(
    (group) =>
      group.id !== configuredGroupId && group.isInternalGroup && group.hasAccessToAllBuilds,
  );
  if (unsafeAutomatic.length > 0) {
    fail("A non-target internal group has automatic access to all builds.");
  }
  return observation;
}

function evidenceStore(observation) {
  const target = observation.groups.find((group) => group.id === observation.configuredGroupId);
  return {
    appId: observation.app.id,
    buildId: observation.build.id,
    uploadId: observation.upload.id,
    configuredGroupId: observation.configuredGroupId,
    assignedGroupIds: observation.groups
      .filter((group) => group.containsBuild)
      .map((group) => group.id)
      .toSorted(),
    uploadState: observation.upload.state.state,
    uploadedAt: observation.upload.uploadedAt,
    processingState: observation.build.processingState,
    expired: observation.build.expired,
    internalBuildState: observation.build.internalBuildState,
    targetAllBuilds: target.hasAccessToAllBuilds,
    nonTargetAutomaticGroupIds: observation.groups
      .filter((group) => group.id !== observation.configuredGroupId && group.hasAccessToAllBuilds)
      .map((group) => group.id)
      .toSorted(),
  };
}

export function createEvidence({
  actor,
  candidate,
  currentRunAttempt,
  currentRunId,
  currentWorkflowSha,
  originalReceipt,
  originalReceiptArtifactId,
  observation,
}) {
  validateOriginalReceipt(originalReceipt);
  validateStoreObservation(observation);
  validateCandidateEvidence(candidate);
  pattern(actor, /^[A-Za-z0-9-]+$/u, "Current actor");
  if (actor !== originalReceipt.actor) {
    fail("Current actor does not match the original authority actor.");
  }
  pattern(currentRunId, POSITIVE_ID, "Current run ID");
  pattern(currentRunAttempt, POSITIVE_ID, "Current run attempt");
  if (currentRunAttempt !== "1") {
    fail("Reconciliation must use run attempt 1.");
  }
  pattern(currentWorkflowSha, SHA, "Current workflow SHA");
  pattern(originalReceiptArtifactId, POSITIVE_ID, "Original receipt artifact ID");
  timestamp(observation.observedAt, "Evidence timestamp");
  return {
    actor,
    appStoreVersion: APP_STORE_VERSION,
    buildNumber: BUILD_NUMBER,
    candidate,
    currentRunAttempt,
    currentRunId,
    currentWorkflowSha,
    gatewayVersion: GATEWAY_VERSION,
    kind: "openclaw-ios-release-reconciliation",
    observedAt: observation.observedAt,
    originalActor: originalReceipt.actor,
    originalJobCompletedAt: ORIGINAL_COMPLETED_AT,
    originalJobId: ORIGINAL_JOB_ID,
    originalJobStartedAt: ORIGINAL_STARTED_AT,
    originalReceiptArtifactId,
    originalReceiptDigest: ORIGINAL_RECEIPT_DIGEST,
    originalRunId: ORIGINAL_RUN_ID,
    originalWorkflowSha: originalReceipt.workflowSha,
    repository: REPOSITORY,
    schemaVersion: 1,
    store: evidenceStore(observation),
    targetRef: TARGET_REF,
    targetSha: CANDIDATE_SHA,
    uploadLogDigest: UPLOAD_LOG_DIGEST,
    workflowPath: WORKFLOW_PATH,
  };
}

export function validateEvidence(evidence, { now = Date.now() } = {}) {
  exactKeys(evidence, EVIDENCE_KEYS, "Reconciliation evidence");
  const expected = {
    kind: "openclaw-ios-release-reconciliation",
    schemaVersion: 1,
    repository: REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    targetRef: TARGET_REF,
    targetSha: CANDIDATE_SHA,
    gatewayVersion: GATEWAY_VERSION,
    appStoreVersion: APP_STORE_VERSION,
    buildNumber: BUILD_NUMBER,
    originalRunId: ORIGINAL_RUN_ID,
    originalJobId: ORIGINAL_JOB_ID,
    originalJobStartedAt: ORIGINAL_STARTED_AT,
    originalJobCompletedAt: ORIGINAL_COMPLETED_AT,
    originalReceiptDigest: ORIGINAL_RECEIPT_DIGEST,
    uploadLogDigest: UPLOAD_LOG_DIGEST,
    currentRunAttempt: "1",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (evidence[key] !== value) {
      fail(`Reconciliation evidence ${key} mismatch.`);
    }
  }
  pattern(evidence.currentRunId, POSITIVE_ID, "Evidence run ID");
  pattern(evidence.currentWorkflowSha, SHA, "Evidence workflow SHA");
  pattern(evidence.originalWorkflowSha, SHA, "Evidence original workflow SHA");
  pattern(evidence.originalReceiptArtifactId, POSITIVE_ID, "Evidence artifact ID");
  validateCandidateEvidence(evidence.candidate);
  if (
    typeof evidence.actor !== "string" ||
    evidence.actor.length === 0 ||
    evidence.actor !== evidence.originalActor
  ) {
    fail("Reconciliation actor continuity is invalid.");
  }
  const observedAt = timestamp(evidence.observedAt, "Evidence timestamp");
  const age = now - observedAt;
  if (age < 0 || age > MAX_OBSERVATION_AGE_MS) {
    fail("Reconciliation evidence is stale.");
  }
  exactKeys(
    evidence.store,
    [
      "appId",
      "assignedGroupIds",
      "buildId",
      "configuredGroupId",
      "expired",
      "internalBuildState",
      "nonTargetAutomaticGroupIds",
      "processingState",
      "targetAllBuilds",
      "uploadId",
      "uploadedAt",
      "uploadState",
    ],
    "Reconciliation store evidence",
  );
  if (
    evidence.store.uploadState !== "COMPLETE" ||
    evidence.store.processingState !== "VALID" ||
    evidence.store.expired !== false ||
    !INTERNAL_TESTING_STATES.has(evidence.store.internalBuildState) ||
    evidence.store.targetAllBuilds !== true ||
    !Array.isArray(evidence.store.assignedGroupIds) ||
    evidence.store.assignedGroupIds.length !== 1 ||
    evidence.store.assignedGroupIds[0] !== evidence.store.configuredGroupId ||
    !Array.isArray(evidence.store.nonTargetAutomaticGroupIds) ||
    evidence.store.nonTargetAutomaticGroupIds.length !== 0
  ) {
    fail("Reconciliation store evidence is not publication-safe.");
  }
  timestamp(evidence.store.uploadedAt, "Evidence upload timestamp");
  return evidence;
}

function ghJson(endpoint) {
  const stdout = execFileSync("gh", ["api", `repos/${REPOSITORY}/${endpoint}`, "--method", "GET"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 60_000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  return JSON.parse(stdout);
}

function permission(login) {
  const value = ghJson(`collaborators/${login}/permission`).permission;
  if (!["admin", "maintain", "write"].includes(value)) {
    fail(`Actor ${login} lacks write permission.`);
  }
}

function validateRun(run, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (run[key] !== value) {
      fail(`Workflow run ${key} mismatch.`);
    }
  }
}

function protectedMainWorkflowPath(value, expected) {
  if (value !== expected && value !== `${expected}@refs/heads/main`) {
    fail("Workflow run path mismatch.");
  }
  return expected;
}

function validateCurrentRun(evidence) {
  const currentRun = ghJson(`actions/runs/${evidence.currentRunId}`);
  validateRun(
    {
      actor: currentRun.actor?.login,
      conclusion: currentRun.conclusion,
      event: currentRun.event,
      head_sha: currentRun.head_sha,
      path: protectedMainWorkflowPath(currentRun.path, WORKFLOW_PATH),
      run_attempt: currentRun.run_attempt,
      status: currentRun.status,
      triggering_actor: currentRun.triggering_actor?.login,
    },
    {
      actor: evidence.actor,
      conclusion: null,
      event: "workflow_dispatch",
      head_sha: evidence.currentWorkflowSha,
      path: WORKFLOW_PATH,
      run_attempt: 1,
      status: "in_progress",
      triggering_actor: evidence.actor,
    },
  );
}

function validateOriginalAuthority(evidence, originalReceipt) {
  const artifact = ghJson(`actions/artifacts/${evidence.originalReceiptArtifactId}`);
  if (
    String(artifact.id ?? "") !== evidence.originalReceiptArtifactId ||
    artifact.name !== `mobile-release-ref-ios-${ORIGINAL_RUN_ID}-1` ||
    artifact.expired !== false ||
    String(artifact.workflow_run?.id ?? "") !== ORIGINAL_RUN_ID ||
    artifact.workflow_run?.head_sha !== originalReceipt.workflowSha
  ) {
    fail("Original authority artifact identity or lifecycle mismatch.");
  }
  const originalRun = ghJson(`actions/runs/${ORIGINAL_RUN_ID}`);
  validateRun(
    {
      actor: originalRun.actor?.login,
      conclusion: originalRun.conclusion,
      event: originalRun.event,
      head_sha: originalRun.head_sha,
      path: protectedMainWorkflowPath(originalRun.path, ORIGINAL_WORKFLOW_PATH),
      run_attempt: originalRun.run_attempt,
      status: originalRun.status,
      triggering_actor: originalRun.triggering_actor?.login,
    },
    {
      actor: originalReceipt.actor,
      conclusion: "failure",
      event: "workflow_dispatch",
      head_sha: originalReceipt.workflowSha,
      path: ORIGINAL_WORKFLOW_PATH,
      run_attempt: 1,
      status: "completed",
      triggering_actor: originalReceipt.actor,
    },
  );
  const job = ghJson(`actions/jobs/${ORIGINAL_JOB_ID}`);
  validateRun(job, {
    completed_at: ORIGINAL_COMPLETED_AT,
    conclusion: "failure",
    head_sha: originalReceipt.workflowSha,
    name: ORIGINAL_JOB_NAME,
    run_attempt: 1,
    run_id: Number(ORIGINAL_RUN_ID),
    started_at: ORIGINAL_STARTED_AT,
    status: "completed",
  });
  permission(evidence.actor);
  if (evidence.actor !== originalReceipt.actor) {
    fail("Current and original actors differ.");
  }
}

function validateEvidenceArtifact(evidence, artifactId, artifactDigest) {
  pattern(artifactId, POSITIVE_ID, "Reconciliation evidence artifact ID");
  pattern(artifactDigest, ARTIFACT_DIGEST, "Reconciliation evidence artifact digest");
  const artifact = ghJson(`actions/artifacts/${artifactId}`);
  if (
    String(artifact.id ?? "") !== artifactId ||
    artifact.name !==
      `ios-release-reconciliation-${evidence.currentRunId}-${evidence.currentRunAttempt}` ||
    artifact.digest !== `sha256:${artifactDigest}` ||
    artifact.expired !== false ||
    String(artifact.workflow_run?.id ?? "") !== evidence.currentRunId ||
    artifact.workflow_run?.head_sha !== evidence.currentWorkflowSha
  ) {
    fail("Reconciliation evidence artifact identity, digest, or lifecycle mismatch.");
  }
}

export function validateLiveAuthority({
  evidence,
  evidenceArtifactDigest,
  evidenceArtifactId,
  originalReceipt,
}) {
  validateOriginalAuthority(evidence, originalReceipt);
  if (evidenceArtifactId !== undefined || evidenceArtifactDigest !== undefined) {
    validateEvidenceArtifact(evidence, evidenceArtifactId, evidenceArtifactDigest);
  }
  validateTargetRef();
  validateCanonicalRef();
  // Keep this as the final remote fact before returning to the recorder call.
  validateCurrentRun(evidence);
}

function validateTargetRef() {
  const ref = `refs/heads/${TARGET_REF}`;
  const result = spawnSync("git", ["ls-remote", "--exit-code", "origin", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status !== 0 || result.stdout !== `${CANDIDATE_SHA}\t${ref}\n`) {
    fail("Frozen mobile release branch moved or is unavailable.");
  }
}

function validateCanonicalRef() {
  const ref = `refs/openclaw/mobile-releases/ios/${APP_STORE_VERSION}-${BUILD_NUMBER}`;
  const result = spawnSync("git", ["ls-remote", "--exit-code", "origin", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status === 2 && result.stdout === "") {
    return "absent";
  }
  if (result.status !== 0) {
    fail("Unable to read the canonical iOS release ref.");
  }
  const expected = `${CANDIDATE_SHA}\t${ref}\n`;
  if (result.stdout !== expected) {
    fail("Canonical iOS release ref moved to a different commit.");
  }
  return "exact";
}

function cliArgs(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "candidate-root": { type: "string" },
      "evidence-artifact-digest": { type: "string" },
      "evidence-artifact-id": { type: "string" },
      "evidence-output": { type: "string" },
      "evidence-path": { type: "string" },
      "group-id": { type: "string" },
      "original-receipt": { type: "string" },
      "original-receipt-artifact-id": { type: "string" },
      "source-job-id": { type: "string" },
      "source-receipt-digest": { type: "string" },
      "source-run-id": { type: "string" },
      "store-observation": { type: "string" },
      "target-ref": { type: "string" },
      "target-sha": { type: "string" },
      "build-number": { type: "string" },
      "upload-log-digest": { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    fail("Expected one reconciliation command.");
  }
  return { command: positionals[0], values };
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`Missing --${key}.`);
  }
  return value;
}

function validateBoundInputs(values) {
  const expected = {
    "build-number": BUILD_NUMBER,
    "source-job-id": ORIGINAL_JOB_ID,
    "source-receipt-digest": ORIGINAL_RECEIPT_DIGEST,
    "source-run-id": ORIGINAL_RUN_ID,
    "target-ref": TARGET_REF,
    "target-sha": CANDIDATE_SHA,
    "upload-log-digest": UPLOAD_LOG_DIGEST,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (required(values, key) !== value) {
      fail(`Reconciliation input --${key} mismatch.`);
    }
  }
}

function readOriginal(values) {
  validateBoundInputs(values);
  const original = readCanonicalJson(
    required(values, "original-receipt"),
    "Original authority receipt",
    4 * 1024,
  );
  if (original.digest !== ORIGINAL_RECEIPT_DIGEST) {
    fail("Original authority receipt digest mismatch.");
  }
  validateOriginalReceipt(original.value);
  return original;
}

function expectedCurrentIdentity() {
  const currentRunId = pattern(process.env.GITHUB_RUN_ID, POSITIVE_ID, "Current run ID");
  const currentRunAttempt = pattern(
    process.env.GITHUB_RUN_ATTEMPT,
    POSITIVE_ID,
    "Current run attempt",
  );
  const currentWorkflowSha = pattern(process.env.GITHUB_WORKFLOW_SHA, SHA, "Current workflow SHA");
  if (
    process.env.GITHUB_REPOSITORY !== REPOSITORY ||
    process.env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` ||
    process.env.GITHUB_ACTOR !== process.env.GITHUB_TRIGGERING_ACTOR
  ) {
    fail("Current workflow identity is invalid.");
  }
  return {
    actor: process.env.GITHUB_ACTOR,
    currentRunAttempt,
    currentRunId,
    currentWorkflowSha,
  };
}

function loadAndValidate(values) {
  const original = readOriginal(values);
  const evidenceFile = readCanonicalJson(
    required(values, "evidence-path"),
    "Reconciliation evidence",
  );
  validateEvidence(evidenceFile.value);
  const current = expectedCurrentIdentity();
  for (const [key, value] of Object.entries(current)) {
    if (evidenceFile.value[key] !== value) {
      fail(`Reconciliation evidence ${key} no longer matches this run.`);
    }
  }
  if (
    evidenceFile.value.originalReceiptArtifactId !==
    required(values, "original-receipt-artifact-id")
  ) {
    fail("Original receipt artifact identity mismatch.");
  }
  if (evidenceFile.value.originalWorkflowSha !== original.value.workflowSha) {
    fail("Original receipt substitution detected.");
  }
  if (evidenceFile.value.store.configuredGroupId !== required(values, "group-id")) {
    fail("Reconciliation evidence group mismatch.");
  }
  validateLiveAuthority({
    evidence: evidenceFile.value,
    evidenceArtifactDigest: required(values, "evidence-artifact-digest"),
    evidenceArtifactId: required(values, "evidence-artifact-id"),
    originalReceipt: original.value,
  });
  validateEvidence(evidenceFile.value);
  return { evidence: evidenceFile.value, original: original.value };
}

function recordRelease() {
  execFileSync(
    process.execPath,
    [
      "--import",
      path.join(process.cwd(), "scripts", "tsx.mjs"),
      path.join(process.cwd(), "scripts", "mobile-release-ref.ts"),
      "record",
      "--platform",
      PLATFORM,
      "--version",
      APP_STORE_VERSION,
      "--build",
      BUILD_NUMBER,
      "--sha",
      CANDIDATE_SHA,
      "--root",
      process.cwd(),
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = cliArgs(argv);
  if (command === "prepare-reader") {
    const original = readOriginal(values);
    const current = expectedCurrentIdentity();
    const candidate = validateCandidateParity(required(values, "candidate-root"));
    const provisional = createEvidence({
      ...current,
      candidate,
      originalReceipt: original.value,
      originalReceiptArtifactId: required(values, "original-receipt-artifact-id"),
      observation: {
        app: { bundleId: "pending", id: "1" },
        build: {
          appStoreVersion: APP_STORE_VERSION,
          buildNumber: BUILD_NUMBER,
          expired: false,
          id: "1",
          internalBuildState: "READY_FOR_BETA_TESTING",
          platform: "IOS",
          processingState: "VALID",
        },
        configuredGroupId: required(values, "group-id"),
        groups: [
          {
            containsBuild: true,
            hasAccessToAllBuilds: true,
            id: required(values, "group-id"),
            isInternalGroup: true,
          },
        ],
        kind: "openclaw-ios-release-store-observation",
        observedAt: new Date().toISOString(),
        readOnly: true,
        schemaVersion: 1,
        upload: {
          buildNumber: BUILD_NUMBER,
          id: "1",
          platform: "IOS",
          shortVersion: APP_STORE_VERSION,
          state: { errors: [], infos: [], state: "COMPLETE", warnings: [] },
          uploadedAt: ORIGINAL_STARTED_AT,
        },
      },
    });
    validateLiveAuthority({ evidence: provisional, originalReceipt: original.value });
    return;
  }
  if (command === "finalize-reader") {
    const original = readOriginal(values);
    const candidate = validateCandidateParity(required(values, "candidate-root"));
    const observation = readCanonicalJson(
      required(values, "store-observation"),
      "Store observation",
    );
    validateStoreObservation(observation.value, {
      configuredGroupId: required(values, "group-id"),
    });
    const evidence = createEvidence({
      ...expectedCurrentIdentity(),
      candidate,
      originalReceipt: original.value,
      originalReceiptArtifactId: required(values, "original-receipt-artifact-id"),
      observation: observation.value,
    });
    validateEvidence(evidence);
    validateLiveAuthority({ evidence, originalReceipt: original.value });
    writeCanonicalJson(required(values, "evidence-output"), evidence);
    return;
  }
  if (command === "validate-recorder") {
    loadAndValidate(values);
    return;
  }
  if (command === "record") {
    loadAndValidate(values);
    recordRelease();
    return;
  }
  fail(`Unknown reconciliation command: ${command}`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
