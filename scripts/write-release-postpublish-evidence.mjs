#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  readJsonFile,
  releasePolicySha256,
  sha256Hex,
  validateArtifactDescriptor,
  validateChangelogEvidence,
  validatePostpublishEvidence,
  validatePublishManifest,
  validateRegistryResult,
  validateReleasePolicy,
  writeCanonicalJsonExclusive,
} from "./lib/release-policy-evidence.mjs";
import { extractStableChangelogSection } from "./lib/stable-release-closeout.mjs";

const FLAG_NAMES = [
  "registry-result",
  "release-policy",
  "release-policy-sha256",
  "publish-manifest",
  "publish-descriptor",
  "changelog-evidence",
  "source-dir",
  "source-sha",
  "release-publish-run-id",
  "release-publish-run-attempt",
  "output",
];
const SHA_RE = /^[0-9a-f]{40}$/u;
const DECIMAL_RE = /^[1-9][0-9]*$/u;

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

function git(sourceDir, args) {
  return execFileSync("git", ["-C", sourceDir, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifySourceCheckout(sourceDir, sourceSha) {
  if (!isAbsolute(sourceDir)) {
    throw new Error("source-dir must be absolute");
  }
  const canonicalDir = realpathSync(sourceDir);
  if (!statSync(canonicalDir).isDirectory()) {
    throw new Error("source-dir must be a directory");
  }
  if (!SHA_RE.test(sourceSha)) {
    throw new Error("source-sha must be 40 lowercase hexadecimal characters");
  }
  const head = git(canonicalDir, ["rev-parse", "HEAD"]);
  if (head !== sourceSha) {
    throw new Error(`source checkout HEAD ${head} does not match ${sourceSha}`);
  }
  const status = git(canonicalDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new Error("source checkout must be clean");
  }
  return canonicalDir;
}

export function buildReleasePostpublishEvidence(params) {
  const registry = validateRegistryResult(params.registryResult);
  if (
    registry.npmRegistrySignaturesVerified !== true ||
    registry.npmProvenanceAttestationMatched !== true
  ) {
    throw new Error("strict postpublish evidence requires verified signatures and provenance");
  }
  const policy = validateReleasePolicy(params.releasePolicy);
  const compatibilityDistTags = { alpha: "alpha", beta: "beta", daily: "latest" };
  const expectedDistTag = compatibilityDistTags[policy.releaseClass];
  if (expectedDistTag !== undefined && registry.npmDistTag !== expectedDistTag) {
    throw new Error(
      `registry result npmDistTag mismatch: expected ${expectedDistTag}, got ${registry.npmDistTag}`,
    );
  }
  const policyDigest = releasePolicySha256(policy);
  if (params.releasePolicySha256 !== policyDigest) {
    throw new Error("releasePolicySha256 mismatch");
  }
  const publishManifest = validatePublishManifest(params.publishManifest);
  const publishDescriptor = validateArtifactDescriptor(params.publishDescriptor);
  const changelogEvidence = validateChangelogEvidence(params.changelogEvidence);
  if (params.publishPayloadSha256 !== publishDescriptor.payloadSha256) {
    throw new Error("publish descriptor payload digest mismatch");
  }
  assertEqual(publishManifest.releasePolicy, policy, "publish releasePolicy");
  if (publishManifest.releasePolicySha256 !== policyDigest) {
    throw new Error("publish releasePolicySha256 mismatch");
  }
  if (
    publishDescriptor.runId !== publishManifest.execution.runId ||
    publishDescriptor.runAttempt !== publishManifest.execution.runAttempt
  ) {
    throw new Error("publish descriptor run mismatch");
  }
  if (
    params.releasePublishRunId !== publishManifest.execution.runId ||
    params.releasePublishRunAttempt !== publishManifest.execution.runAttempt
  ) {
    throw new Error("postpublish invocation run mismatch");
  }
  if (
    registry.releaseVersion !== policy.releaseVersion ||
    registry.releaseTag !== publishManifest.target.releaseTag
  ) {
    throw new Error("registry result release identity mismatch");
  }
  assertEqual(publishManifest.changelogEvidence, changelogEvidence, "publish changelogEvidence");
  if (
    params.sourceSha !== publishManifest.target.targetSha ||
    publishManifest.target.authorizedSourceRef !== policy.authorizedSourceRef
  ) {
    throw new Error("publish target/source authority mismatch");
  }
  const section = extractStableChangelogSection(
    readFileSync(join(params.sourceDir, "CHANGELOG.md"), "utf8"),
    policy.releaseVersion,
  );
  if (section === null) {
    throw new Error(`source CHANGELOG.md is missing ## ${policy.releaseVersion}`);
  }
  if (
    changelogEvidence.tag !== `v${policy.releaseVersion}` ||
    changelogEvidence.sourceRef !== policy.authorizedSourceRef ||
    changelogEvidence.sectionHeading !== `## ${policy.releaseVersion}` ||
    changelogEvidence.sectionSha256 !== sha256Hex(section)
  ) {
    throw new Error("source changelog evidence mismatch");
  }

  return validatePostpublishEvidence({
    ...registry,
    version: 2,
    releasePublishRunId: params.releasePublishRunId,
    releasePublishRunAttempt: params.releasePublishRunAttempt,
    releasePolicy: policy,
    releasePolicySha256: policyDigest,
    publishManifest: publishDescriptor,
    changelogEvidence,
  });
}

export function writeReleasePostpublishEvidence(argv) {
  const flags = parseFlags(argv);
  if (!DECIMAL_RE.test(flags["release-publish-run-id"])) {
    throw new Error("release-publish-run-id must be a positive decimal string");
  }
  if (!DECIMAL_RE.test(flags["release-publish-run-attempt"])) {
    throw new Error("release-publish-run-attempt must be a positive decimal string");
  }
  const sourceDir = verifySourceCheckout(flags["source-dir"], flags["source-sha"]);
  const registryResult = readJsonFile(flags["registry-result"], "registry result");
  const releasePolicy = readJsonFile(flags["release-policy"], "release policy");
  const publishManifest = readJsonFile(flags["publish-manifest"], "publish manifest");
  const publishDescriptor = readJsonFile(flags["publish-descriptor"], "publish descriptor");
  const changelogEvidence = readJsonFile(flags["changelog-evidence"], "changelog evidence");
  const evidence = buildReleasePostpublishEvidence({
    registryResult: registryResult.value,
    releasePolicy: releasePolicy.value,
    releasePolicySha256: flags["release-policy-sha256"],
    publishManifest: publishManifest.value,
    publishDescriptor: publishDescriptor.value,
    publishPayloadSha256: sha256Hex(publishManifest.bytes),
    changelogEvidence: changelogEvidence.value,
    sourceDir,
    sourceSha: flags["source-sha"],
    releasePublishRunId: flags["release-publish-run-id"],
    releasePublishRunAttempt: flags["release-publish-run-attempt"],
  });
  writeCanonicalJsonExclusive(flags.output, evidence);
  return evidence;
}

function main() {
  try {
    writeReleasePostpublishEvidence(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `write-release-postpublish-evidence: ${error instanceof Error ? error.message : "internal error"}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
