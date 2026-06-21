#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  readJsonFile,
  releasePolicySha256,
  sha256Hex,
  validateArtifactDescriptor,
  validateChangelogEvidence,
  validateFullValidationManifest,
  validatePreflightManifest,
  validatePublishManifest,
  validateReleaseOperationResult,
  validateReleasePolicy,
  writeCanonicalJsonExclusive,
} from "./lib/release-policy-evidence.mjs";

const FLAG_NAMES = [
  "release-policy",
  "release-policy-sha256",
  "preflight-manifest",
  "preflight-descriptor",
  "full-validation-manifest",
  "full-validation-descriptor",
  "verification-result",
  "changelog-evidence",
  "output",
];

function parseFlags(argv) {
  if (argv.length !== FLAG_NAMES.length * 2) {
    throw new Error(`expected exactly ${FLAG_NAMES.length} flag/value pairs`);
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token.startsWith("--") || !FLAG_NAMES.includes(token.slice(2))) {
      throw new Error(`unknown argument "${token}"`);
    }
    const name = token.slice(2);
    if (Object.hasOwn(values, name)) {
      throw new Error(`duplicate argument "--${name}"`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for "--${name}"`);
    }
    values[name] = value;
  }
  for (const name of FLAG_NAMES) {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`missing argument "--${name}"`);
    }
  }
  return values;
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

export function buildReleasePublishManifest(params) {
  const policy = validateReleasePolicy(params.releasePolicy);
  const policyDigest = releasePolicySha256(policy);
  if (params.releasePolicySha256 !== policyDigest) {
    throw new Error("releasePolicySha256 mismatch");
  }
  const preflight = validatePreflightManifest(params.preflightManifest);
  if (preflight.version !== 2 || !preflight.releasePolicy.publishEligible) {
    throw new Error("publish requires publishable preflight v2");
  }
  const fullValidation = validateFullValidationManifest(params.fullValidationManifest);
  if (fullValidation.version !== 3) {
    throw new Error("publish requires Full Release Validation v3");
  }
  const preflightDescriptor = validateArtifactDescriptor(
    params.preflightDescriptor,
    "preflightDescriptor",
  );
  const fullValidationDescriptor = validateArtifactDescriptor(
    params.fullValidationDescriptor,
    "fullValidationDescriptor",
  );
  const verification = validateReleaseOperationResult(params.verificationResult);
  if (verification.operation !== "publish") {
    throw new Error("verification result must authorize publish");
  }
  const changelogEvidence = validateChangelogEvidence(params.changelogEvidence);

  assertEqual(preflight.releasePolicy, policy, "preflight releasePolicy");
  assertEqual(fullValidation.releasePolicy, policy, "Full Validation releasePolicy");
  if (
    preflight.releasePolicySha256 !== policyDigest ||
    fullValidation.releasePolicySha256 !== policyDigest
  ) {
    throw new Error("predecessor releasePolicySha256 mismatch");
  }
  if (preflightDescriptor.payloadSha256 !== params.preflightPayloadSha256) {
    throw new Error("preflight descriptor payload digest mismatch");
  }
  if (fullValidationDescriptor.payloadSha256 !== params.fullValidationPayloadSha256) {
    throw new Error("Full Validation descriptor payload digest mismatch");
  }
  if (
    fullValidationDescriptor.runId !== fullValidation.runId ||
    fullValidationDescriptor.runAttempt !== fullValidation.runAttempt
  ) {
    throw new Error("Full Validation descriptor run mismatch");
  }
  if (
    verification.releaseVersion !== policy.releaseVersion ||
    verification.releaseClass !== policy.releaseClass ||
    verification.releaseSelector !== policy.releaseSelector ||
    verification.policyMode !== policy.policyMode
  ) {
    throw new Error("verification policy identity mismatch");
  }
  assertEqual(verification.policySource, policy.policySource, "verification policySource");
  if (
    verification.target.releaseTag !== changelogEvidence.tag ||
    verification.target.authorizedSourceRef !== changelogEvidence.sourceRef
  ) {
    throw new Error("verification changelog identity mismatch");
  }

  return validatePublishManifest({
    version: 1,
    releasePolicy: policy,
    releasePolicySha256: policyDigest,
    preflight: {
      runId: preflightDescriptor.runId,
      runAttempt: preflightDescriptor.runAttempt,
      payloadSha256: preflightDescriptor.payloadSha256,
    },
    fullValidation: {
      runId: fullValidationDescriptor.runId,
      runAttempt: fullValidationDescriptor.runAttempt,
      payloadSha256: fullValidationDescriptor.payloadSha256,
    },
    execution: verification.execution,
    target: verification.target,
    changelogEvidence,
  });
}

export function writeReleasePublishManifest(argv) {
  const flags = parseFlags(argv);
  const releasePolicy = readJsonFile(flags["release-policy"], "release policy");
  const preflightManifest = readJsonFile(flags["preflight-manifest"], "preflight manifest");
  const preflightDescriptor = readJsonFile(flags["preflight-descriptor"], "preflight descriptor");
  const fullValidationManifest = readJsonFile(
    flags["full-validation-manifest"],
    "Full Validation manifest",
  );
  const fullValidationDescriptor = readJsonFile(
    flags["full-validation-descriptor"],
    "Full Validation descriptor",
  );
  const verificationResult = readJsonFile(flags["verification-result"], "verification result");
  const changelogEvidence = readJsonFile(flags["changelog-evidence"], "changelog evidence");

  const manifest = buildReleasePublishManifest({
    releasePolicy: releasePolicy.value,
    releasePolicySha256: flags["release-policy-sha256"],
    preflightManifest: preflightManifest.value,
    preflightDescriptor: preflightDescriptor.value,
    preflightPayloadSha256: sha256Hex(preflightManifest.bytes),
    fullValidationManifest: fullValidationManifest.value,
    fullValidationDescriptor: fullValidationDescriptor.value,
    fullValidationPayloadSha256: sha256Hex(fullValidationManifest.bytes),
    verificationResult: verificationResult.value,
    changelogEvidence: changelogEvidence.value,
  });
  writeCanonicalJsonExclusive(flags.output, manifest);
  return manifest;
}

function main() {
  try {
    writeReleasePublishManifest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `write-release-publish-manifest: ${error instanceof Error ? error.message : "internal error"}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
