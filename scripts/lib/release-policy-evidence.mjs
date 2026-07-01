import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const DECIMAL_RE = /^[1-9][0-9]*$/u;
const RELEASE_CLASSES = new Set([
  "alpha",
  "beta",
  "daily",
  "stable-base",
  "stable-patch",
  "historical-correction",
]);
const RELEASE_SELECTORS = new Set(["alpha", "beta", "daily", "stable"]);

function fail(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function objectAt(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected object");
  }
  return value;
}

function closedObject(value, path, keys) {
  const object = objectAt(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(path, `unknown field "${key}"`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) {
      fail(path, `missing field "${key}"`);
    }
  }
  return object;
}

function stringAt(value, path) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/u.test(value)) {
    fail(path, "expected non-empty single-line string");
  }
  return value;
}

function exactString(value, path, expected) {
  const actual = stringAt(value, path);
  if (actual !== expected) {
    fail(path, `expected "${expected}"`);
  }
  return actual;
}

function decimalAt(value, path) {
  const actual = stringAt(value, path);
  if (!DECIMAL_RE.test(actual)) {
    fail(path, "expected positive decimal string");
  }
  return actual;
}

function shaAt(value, path) {
  const actual = stringAt(value, path);
  if (!SHA_RE.test(actual)) {
    fail(path, "expected 40 lowercase hexadecimal characters");
  }
  return actual;
}

function digestAt(value, path) {
  const actual = stringAt(value, path);
  if (!DIGEST_RE.test(actual)) {
    fail(path, "expected 64 lowercase hexadecimal characters");
  }
  return actual;
}

function canonicalize(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(path, "expected finite JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === undefined) {
    fail(path, "expected JSON value");
  }
  const result = {};
  for (const key of Object.keys(value).toSorted()) {
    result[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonWithNewline(value) {
  return `${canonicalJson(value)}\n`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readJsonFile(path, label = path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "could not read file");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(label, "invalid JSON");
  }
  return { bytes, value };
}

export function writeCanonicalJsonExclusive(path, value) {
  const outputPath = resolve(path);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  let directoryDescriptor;
  let installed = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, canonicalJsonWithNewline(value), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, outputPath);
    installed = true;
    unlinkSync(temporaryPath);
    directoryDescriptor = openSync(dirname(outputPath), "r");
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (directoryDescriptor !== undefined) {
      closeSync(directoryDescriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {}
    if (installed) {
      try {
        unlinkSync(outputPath);
      } catch {}
    }
    throw error;
  }
}

export function releasePolicySha256(policy) {
  return sha256Hex(canonicalJson(validateReleasePolicy(policy)));
}

export function validateReleasePolicy(value, path = "releasePolicy") {
  const policy = closedObject(value, path, [
    "version",
    "releaseVersion",
    "releaseClass",
    "releaseSelector",
    "policyMode",
    "publishEligible",
    "authorizedSourceRef",
    "policySource",
  ]);
  if (policy.version !== 1) {
    fail(`${path}.version`, "expected 1");
  }
  stringAt(policy.releaseVersion, `${path}.releaseVersion`);
  if (!RELEASE_CLASSES.has(policy.releaseClass)) {
    fail(`${path}.releaseClass`, "unsupported release class");
  }
  if (policy.policyMode !== "legacy" && policy.policyMode !== "strict") {
    fail(`${path}.policyMode`, "expected legacy or strict");
  }
  if (policy.policyMode === "legacy") {
    if (policy.releaseSelector !== null) {
      fail(`${path}.releaseSelector`, "must be null in legacy mode");
    }
  } else if (!RELEASE_SELECTORS.has(policy.releaseSelector)) {
    fail(`${path}.releaseSelector`, "must be a known selector in strict mode");
  }
  if (typeof policy.publishEligible !== "boolean") {
    fail(`${path}.publishEligible`, "expected boolean");
  }
  if (policy.authorizedSourceRef !== null) {
    stringAt(policy.authorizedSourceRef, `${path}.authorizedSourceRef`);
  }

  const policySource = closedObject(policy.policySource, `${path}.policySource`, ["sha", "blobs"]);
  shaAt(policySource.sha, `${path}.policySource.sha`);
  const blobs = closedObject(policySource.blobs, `${path}.policySource.blobs`, [
    "releaseVersionPolicySha256",
    "stableReleaseLinesModuleSha256",
    "verifyReleaseOperationSha256",
    "stableLinesSha256",
  ]);
  digestAt(
    blobs.releaseVersionPolicySha256,
    `${path}.policySource.blobs.releaseVersionPolicySha256`,
  );
  digestAt(
    blobs.stableReleaseLinesModuleSha256,
    `${path}.policySource.blobs.stableReleaseLinesModuleSha256`,
  );
  digestAt(
    blobs.verifyReleaseOperationSha256,
    `${path}.policySource.blobs.verifyReleaseOperationSha256`,
  );
  const stableClass =
    policy.releaseClass === "stable-base" || policy.releaseClass === "stable-patch";
  if (stableClass) {
    digestAt(blobs.stableLinesSha256, `${path}.policySource.blobs.stableLinesSha256`);
  } else if (blobs.stableLinesSha256 !== null) {
    fail(`${path}.policySource.blobs.stableLinesSha256`, "must be null for non-stable class");
  }
  if (policy.policyMode === "strict") {
    const expectedSelector =
      policy.releaseClass === "stable-base" || policy.releaseClass === "stable-patch"
        ? "stable"
        : policy.releaseClass;
    if (policy.releaseSelector !== expectedSelector) {
      fail(`${path}.releaseSelector`, `does not match release class ${policy.releaseClass}`);
    }
    if (
      !stableClass &&
      policy.releaseClass !== "historical-correction" &&
      !policy.publishEligible
    ) {
      fail(`${path}.publishEligible`, "strict prerelease and daily policy must be publishable");
    }
  }
  return policy;
}

export function validateArtifactDescriptor(value, path = "descriptor") {
  const descriptor = closedObject(value, path, [
    "runId",
    "runAttempt",
    "artifactName",
    "payloadSha256",
  ]);
  decimalAt(descriptor.runId, `${path}.runId`);
  decimalAt(descriptor.runAttempt, `${path}.runAttempt`);
  stringAt(descriptor.artifactName, `${path}.artifactName`);
  digestAt(descriptor.payloadSha256, `${path}.payloadSha256`);
  return descriptor;
}

function validatePredecessorDescriptor(value, path = "descriptor") {
  const descriptor = closedObject(value, path, ["runId", "runAttempt", "payloadSha256"]);
  decimalAt(descriptor.runId, `${path}.runId`);
  decimalAt(descriptor.runAttempt, `${path}.runAttempt`);
  digestAt(descriptor.payloadSha256, `${path}.payloadSha256`);
  return descriptor;
}

export function validateChangelogEvidence(value, path = "changelogEvidence") {
  const evidence = closedObject(value, path, [
    "tag",
    "sourceRef",
    "sectionHeading",
    "sectionSha256",
  ]);
  stringAt(evidence.tag, `${path}.tag`);
  stringAt(evidence.sourceRef, `${path}.sourceRef`);
  stringAt(evidence.sectionHeading, `${path}.sectionHeading`);
  digestAt(evidence.sectionSha256, `${path}.sectionSha256`);
  return evidence;
}

export function validatePreflightManifest(value, path = "preflightManifest") {
  const baseKeys = [
    "version",
    "releaseTag",
    "releaseSha",
    "npmDistTag",
    "packageName",
    "packageVersion",
    "tarballName",
    "tarballSha256",
    "dependencyEvidenceDir",
    "dependencyEvidenceManifest",
  ];
  const raw = objectAt(value, path);
  const manifest = closedObject(
    value,
    path,
    raw.version === 2 ? [...baseKeys, "releasePolicy", "releasePolicySha256"] : baseKeys,
  );
  if (manifest.version !== 1 && manifest.version !== 2) {
    fail(`${path}.version`, "expected 1 or 2");
  }
  stringAt(manifest.releaseTag, `${path}.releaseTag`);
  shaAt(manifest.releaseSha, `${path}.releaseSha`);
  exactString(manifest.packageName, `${path}.packageName`, "openclaw");
  stringAt(manifest.packageVersion, `${path}.packageVersion`);
  if (manifest.version === 1) {
    for (const key of [
      "npmDistTag",
      "tarballName",
      "tarballSha256",
      "dependencyEvidenceDir",
      "dependencyEvidenceManifest",
    ]) {
      stringAt(manifest[key], `${path}.${key}`);
    }
    digestAt(manifest.tarballSha256, `${path}.tarballSha256`);
    return manifest;
  }

  const policy = validateReleasePolicy(manifest.releasePolicy, `${path}.releasePolicy`);
  digestAt(manifest.releasePolicySha256, `${path}.releasePolicySha256`);
  if (manifest.releasePolicySha256 !== releasePolicySha256(policy)) {
    fail(`${path}.releasePolicySha256`, "does not match canonical release policy bytes");
  }
  exactString(manifest.releaseTag, `${path}.releaseTag`, `v${policy.releaseVersion}`);
  exactString(manifest.packageVersion, `${path}.packageVersion`, policy.releaseVersion);
  const publicationKeys = [
    "npmDistTag",
    "tarballName",
    "tarballSha256",
    "dependencyEvidenceDir",
    "dependencyEvidenceManifest",
  ];
  if (policy.publishEligible) {
    for (const key of publicationKeys) {
      stringAt(manifest[key], `${path}.${key}`);
    }
    digestAt(manifest.tarballSha256, `${path}.tarballSha256`);
  } else {
    for (const key of publicationKeys) {
      if (manifest[key] !== null) {
        fail(`${path}.${key}`, "must be null for policy-only preflight");
      }
    }
  }
  return manifest;
}

export function validateFullValidationManifest(value, path = "fullValidationManifest") {
  const baseKeys = [
    "version",
    "workflowName",
    "runId",
    "runAttempt",
    "workflowRef",
    "targetRef",
    "targetSha",
    "releaseProfile",
    "rerunGroup",
    "runReleaseSoak",
    "controls",
    "childRuns",
  ];
  const raw = objectAt(value, path);
  const manifest = closedObject(
    value,
    path,
    raw.version === 3 ? [...baseKeys, "releasePolicy", "releasePolicySha256"] : baseKeys,
  );
  if (manifest.version !== 2 && manifest.version !== 3) {
    fail(`${path}.version`, "expected 2 or 3");
  }
  for (const key of ["workflowName", "workflowRef", "targetRef", "releaseProfile", "rerunGroup"]) {
    stringAt(manifest[key], `${path}.${key}`);
  }
  decimalAt(manifest.runId, `${path}.runId`);
  decimalAt(manifest.runAttempt, `${path}.runAttempt`);
  shaAt(manifest.targetSha, `${path}.targetSha`);
  if (manifest.runReleaseSoak !== "true" && manifest.runReleaseSoak !== "false") {
    fail(`${path}.runReleaseSoak`, "expected true or false string");
  }
  const controls = closedObject(manifest.controls, `${path}.controls`, [
    "stableSoakRequired",
    "performanceBlocking",
  ]);
  if (
    typeof controls.stableSoakRequired !== "boolean" ||
    typeof controls.performanceBlocking !== "boolean"
  ) {
    fail(`${path}.controls`, "expected boolean controls");
  }
  const childRuns = closedObject(manifest.childRuns, `${path}.childRuns`, [
    "normalCi",
    "pluginPrerelease",
    "releaseChecks",
    "npmTelegram",
    "productPerformance",
  ]);
  for (const key of ["normalCi", "pluginPrerelease", "releaseChecks", "npmTelegram"]) {
    stringAt(childRuns[key], `${path}.childRuns.${key}`);
  }
  const performance = closedObject(
    childRuns.productPerformance,
    `${path}.childRuns.productPerformance`,
    ["runId", "conclusion", "blocking"],
  );
  stringAt(performance.runId, `${path}.childRuns.productPerformance.runId`);
  stringAt(performance.conclusion, `${path}.childRuns.productPerformance.conclusion`);
  if (typeof performance.blocking !== "boolean") {
    fail(`${path}.childRuns.productPerformance.blocking`, "expected boolean");
  }
  if (manifest.version === 3) {
    const policy = validateReleasePolicy(manifest.releasePolicy, `${path}.releasePolicy`);
    digestAt(manifest.releasePolicySha256, `${path}.releasePolicySha256`);
    if (manifest.releasePolicySha256 !== releasePolicySha256(policy)) {
      fail(`${path}.releasePolicySha256`, "does not match canonical release policy bytes");
    }
  }
  return manifest;
}

function validateExecution(value, path) {
  const execution = closedObject(value, path, [
    "event",
    "workflowPath",
    "executionRef",
    "runHeadSha",
    "runId",
    "runAttempt",
  ]);
  stringAt(execution.event, `${path}.event`);
  stringAt(execution.workflowPath, `${path}.workflowPath`);
  stringAt(execution.executionRef, `${path}.executionRef`);
  shaAt(execution.runHeadSha, `${path}.runHeadSha`);
  decimalAt(execution.runId, `${path}.runId`);
  decimalAt(execution.runAttempt, `${path}.runAttempt`);
  return execution;
}

function validateTarget(value, path) {
  const target = closedObject(value, path, [
    "targetRef",
    "targetSha",
    "releaseTag",
    "authorizedSourceRef",
    "authorizedSourceTipSha",
    "targetReachableFromAuthorizedSource",
  ]);
  stringAt(target.targetRef, `${path}.targetRef`);
  shaAt(target.targetSha, `${path}.targetSha`);
  stringAt(target.releaseTag, `${path}.releaseTag`);
  stringAt(target.authorizedSourceRef, `${path}.authorizedSourceRef`);
  shaAt(target.authorizedSourceTipSha, `${path}.authorizedSourceTipSha`);
  if (target.targetReachableFromAuthorizedSource !== true) {
    fail(`${path}.targetReachableFromAuthorizedSource`, "expected true");
  }
  return target;
}

export function validateReleaseOperationResult(value, path = "verificationResult") {
  const result = closedObject(value, path, [
    "schemaVersion",
    "ok",
    "operation",
    "releaseVersion",
    "releaseClass",
    "releaseSelector",
    "policyMode",
    "policySource",
    "execution",
    "target",
  ]);
  if (result.schemaVersion !== 1 || result.ok !== true) {
    fail(path, "expected successful v1 verifier result");
  }
  if (
    ![
      "sha-preflight",
      "tag-preflight",
      "internal-validation",
      "publish",
      "postpublish",
      "stable-closeout",
    ].includes(result.operation)
  ) {
    fail(`${path}.operation`, "unsupported operation");
  }
  stringAt(result.releaseVersion, `${path}.releaseVersion`);
  if (!RELEASE_CLASSES.has(result.releaseClass)) {
    fail(`${path}.releaseClass`, "unsupported release class");
  }
  if (result.policyMode !== "legacy" && result.policyMode !== "strict") {
    fail(`${path}.policyMode`, "expected legacy or strict");
  }
  if (result.policyMode === "legacy") {
    if (result.releaseSelector !== null) {
      fail(`${path}.releaseSelector`, "must be null in legacy mode");
    }
  } else if (!RELEASE_SELECTORS.has(result.releaseSelector)) {
    fail(`${path}.releaseSelector`, "must be a known selector in strict mode");
  }
  const policySource = closedObject(result.policySource, `${path}.policySource`, ["sha", "blobs"]);
  shaAt(policySource.sha, `${path}.policySource.sha`);
  const blobs = closedObject(policySource.blobs, `${path}.policySource.blobs`, [
    "releaseVersionPolicySha256",
    "stableReleaseLinesModuleSha256",
    "verifyReleaseOperationSha256",
    "stableLinesSha256",
  ]);
  digestAt(
    blobs.releaseVersionPolicySha256,
    `${path}.policySource.blobs.releaseVersionPolicySha256`,
  );
  digestAt(
    blobs.stableReleaseLinesModuleSha256,
    `${path}.policySource.blobs.stableReleaseLinesModuleSha256`,
  );
  digestAt(
    blobs.verifyReleaseOperationSha256,
    `${path}.policySource.blobs.verifyReleaseOperationSha256`,
  );
  if (blobs.stableLinesSha256 !== null) {
    digestAt(blobs.stableLinesSha256, `${path}.policySource.blobs.stableLinesSha256`);
  }
  validateExecution(result.execution, `${path}.execution`);
  if (result.operation === "sha-preflight") {
    const target = closedObject(result.target, `${path}.target`, [
      "targetRef",
      "targetSha",
      "releaseTag",
      "authorizedSourceRef",
      "authorizedSourceTipSha",
      "targetReachableFromAuthorizedSource",
    ]);
    for (const key of [
      "targetRef",
      "releaseTag",
      "authorizedSourceRef",
      "authorizedSourceTipSha",
      "targetReachableFromAuthorizedSource",
    ]) {
      if (target[key] !== null) {
        fail(`${path}.target.${key}`, "must be null for sha-preflight");
      }
    }
    shaAt(target.targetSha, `${path}.target.targetSha`);
  } else {
    validateTarget(result.target, `${path}.target`);
  }
  return result;
}

export function validatePublishManifest(value, path = "publishManifest") {
  const manifest = closedObject(value, path, [
    "version",
    "releasePolicy",
    "releasePolicySha256",
    "preflight",
    "fullValidation",
    "execution",
    "target",
    "changelogEvidence",
  ]);
  if (manifest.version !== 1) {
    fail(`${path}.version`, "expected 1");
  }
  const policy = validateReleasePolicy(manifest.releasePolicy, `${path}.releasePolicy`);
  digestAt(manifest.releasePolicySha256, `${path}.releasePolicySha256`);
  if (manifest.releasePolicySha256 !== releasePolicySha256(policy)) {
    fail(`${path}.releasePolicySha256`, "does not match canonical release policy bytes");
  }
  if (!policy.publishEligible) {
    fail(`${path}.releasePolicy.publishEligible`, "publish manifest requires publishable policy");
  }
  validatePredecessorDescriptor(manifest.preflight, `${path}.preflight`);
  validatePredecessorDescriptor(manifest.fullValidation, `${path}.fullValidation`);
  validateExecution(manifest.execution, `${path}.execution`);
  const target = validateTarget(manifest.target, `${path}.target`);
  const changelog = validateChangelogEvidence(
    manifest.changelogEvidence,
    `${path}.changelogEvidence`,
  );
  const expectedTag = `v${policy.releaseVersion}`;
  exactString(target.releaseTag, `${path}.target.releaseTag`, expectedTag);
  exactString(changelog.tag, `${path}.changelogEvidence.tag`, expectedTag);
  if (target.authorizedSourceRef !== policy.authorizedSourceRef) {
    fail(`${path}.target.authorizedSourceRef`, "does not match release policy");
  }
  if (changelog.sourceRef !== policy.authorizedSourceRef) {
    fail(`${path}.changelogEvidence.sourceRef`, "does not match release policy");
  }
  return manifest;
}

export function validateRegistryResult(value, path = "registryResult") {
  const result = closedObject(value, path, [
    "version",
    "releaseVersion",
    "releaseTag",
    "npmDistTag",
    "pluginSelection",
    "openclawNpmIntegrity",
    "openclawNpmTarball",
    "npmRegistrySignaturesVerified",
    "npmProvenanceAttestationMatched",
    "githubReleaseUrl",
    "pluginNpmPackageCount",
    "clawHubPackageCount",
    "workflowRuns",
  ]);
  if (result.version !== 1) {
    fail(`${path}.version`, "expected 1");
  }
  for (const key of [
    "releaseVersion",
    "releaseTag",
    "npmDistTag",
    "openclawNpmIntegrity",
    "openclawNpmTarball",
  ]) {
    stringAt(result[key], `${path}.${key}`);
  }
  if (!Array.isArray(result.pluginSelection)) {
    fail(`${path}.pluginSelection`, "expected string array");
  }
  result.pluginSelection.forEach((plugin, index) =>
    stringAt(plugin, `${path}.pluginSelection[${index}]`),
  );
  for (const key of ["npmRegistrySignaturesVerified", "npmProvenanceAttestationMatched"]) {
    if (result[key] !== true && result[key] !== null) {
      fail(`${path}.${key}`, "expected true or null");
    }
  }
  if (result.githubReleaseUrl !== null) {
    stringAt(result.githubReleaseUrl, `${path}.githubReleaseUrl`);
  }
  for (const key of ["pluginNpmPackageCount", "clawHubPackageCount"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      fail(`${path}.${key}`, "expected non-negative integer");
    }
  }
  if (!Array.isArray(result.workflowRuns)) {
    fail(`${path}.workflowRuns`, "expected array");
  }
  result.workflowRuns.forEach((item, index) => {
    const recordPath = `${path}.workflowRuns[${index}]`;
    const record = objectAt(item, recordPath);
    const keys = ["id", "label"];
    if (Object.hasOwn(record, "url")) {
      keys.push("url");
    }
    if (Object.hasOwn(record, "durationSeconds")) {
      keys.push("durationSeconds");
    }
    closedObject(record, recordPath, keys);
    stringAt(record.id, `${recordPath}.id`);
    stringAt(record.label, `${recordPath}.label`);
    if (Object.hasOwn(record, "url")) {
      stringAt(record.url, `${recordPath}.url`);
    }
    if (
      Object.hasOwn(record, "durationSeconds") &&
      (!Number.isFinite(record.durationSeconds) || record.durationSeconds < 0)
    ) {
      fail(`${recordPath}.durationSeconds`, "expected non-negative number");
    }
  });
  return result;
}

export function validatePostpublishEvidence(value, path = "postpublishEvidence") {
  const result = closedObject(value, path, [
    "version",
    "releaseVersion",
    "releaseTag",
    "npmDistTag",
    "pluginSelection",
    "openclawNpmIntegrity",
    "openclawNpmTarball",
    "npmRegistrySignaturesVerified",
    "npmProvenanceAttestationMatched",
    "githubReleaseUrl",
    "pluginNpmPackageCount",
    "clawHubPackageCount",
    "workflowRuns",
    "releasePublishRunId",
    "releasePublishRunAttempt",
    "releasePolicy",
    "releasePolicySha256",
    "publishManifest",
    "changelogEvidence",
  ]);
  const registryResult = { ...result, version: 1 };
  for (const key of [
    "releasePublishRunId",
    "releasePublishRunAttempt",
    "releasePolicy",
    "releasePolicySha256",
    "publishManifest",
    "changelogEvidence",
  ]) {
    delete registryResult[key];
  }
  validateRegistryResult(registryResult, `${path}.registryFields`);
  if (result.version !== 2) {
    fail(`${path}.version`, "expected 2");
  }
  if (
    result.npmRegistrySignaturesVerified !== true ||
    result.npmProvenanceAttestationMatched !== true
  ) {
    fail(path, "strict postpublish evidence requires registry signatures and provenance");
  }
  decimalAt(result.releasePublishRunId, `${path}.releasePublishRunId`);
  decimalAt(result.releasePublishRunAttempt, `${path}.releasePublishRunAttempt`);
  const policy = validateReleasePolicy(result.releasePolicy, `${path}.releasePolicy`);
  digestAt(result.releasePolicySha256, `${path}.releasePolicySha256`);
  if (result.releasePolicySha256 !== releasePolicySha256(policy)) {
    fail(`${path}.releasePolicySha256`, "does not match canonical release policy bytes");
  }
  validateArtifactDescriptor(result.publishManifest, `${path}.publishManifest`);
  validateChangelogEvidence(result.changelogEvidence, `${path}.changelogEvidence`);
  return result;
}
