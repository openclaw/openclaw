#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import {
  dedicatedSectionVersionForTag,
  releaseNotesSectionForTag,
  releaseNotesVersionForTag,
} from "./render-github-release-notes.mjs";

const WORKFLOW_PATH = ".github/workflows/release-ledger.yml";
const ARTIFACT_NAME = "release-ledger-evidence";
const ARTIFACT_MEMBER = "release-ledger-manifest.json";
const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const VERSION_RE = /^[0-9]{4}\.([1-9]|1[0-2])\.[1-9][0-9]*(?:-[1-9][0-9]*)?$/u;
const RELEASE_REF_RE = /^release\/[0-9]{4}\.([1-9]|1[0-2])\.[1-9][0-9]*$/u;
const EXPECTED_TOP_LEVEL_KEYS = [
  "artifacts",
  "base",
  "directCommits",
  "directReconciliation",
  "finalTarget",
  "inventory",
  "invocation",
  "mergeBase",
  "pullRequests",
  "reconciliation",
  "reconciliations",
  "schemaVersion",
  "seedAuthorization",
  "shippedBaselines",
  "source",
  "status",
  "target",
  "tooling",
  "unlinkedCommits",
  "version",
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `${label} must be a positive safe integer`);
  return parsed;
}

function exactString(value, label) {
  assert(
    typeof value === "string" && value.length > 0 && value.trim() === value,
    `${label} is required`,
  );
  return value;
}

function exactSha(value, label) {
  const sha = exactString(value, label);
  assert(SHA_RE.test(sha), `${label} must be a full lowercase commit SHA`);
  return sha;
}

function exactSha256(value, label) {
  const digest = exactString(value, label);
  assert(SHA256_RE.test(digest), `${label} must be 64 lowercase hex characters`);
  return digest;
}

function parseFlagValues(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(
      flag?.startsWith("--") && value !== undefined,
      `invalid argument near ${flag ?? "<end>"}`,
    );
    assert(!values.has(flag), `duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  return values;
}

function parseArgs(values) {
  const allowed = new Set([
    "--artifact-digest",
    "--artifact-id",
    "--artifact-member",
    "--artifact-name",
    "--artifact-size-bytes",
    "--base-ref",
    "--manifest-sha256",
    "--release-ref",
    "--release-sha",
    "--release-tag",
    "--repository",
    "--run-attempt",
    "--run-id",
    "--source-sha",
    "--tooling-tree",
    "--version",
    "--workflow-sha",
  ]);
  for (const flag of values.keys()) {
    assert(allowed.has(flag), `unknown argument: ${flag}`);
  }
  const required = (flag) => exactString(values.get(flag), flag);
  const artifactDigest = required("--artifact-digest");
  assert(DIGEST_RE.test(artifactDigest), "--artifact-digest must be sha256:<64 lowercase hex>");
  const artifactName = required("--artifact-name");
  const artifactMember = required("--artifact-member");
  assert(artifactName === ARTIFACT_NAME, `--artifact-name must be ${ARTIFACT_NAME}`);
  assert(artifactMember === ARTIFACT_MEMBER, `--artifact-member must be ${ARTIFACT_MEMBER}`);
  const releaseRef = required("--release-ref");
  assert(RELEASE_REF_RE.test(releaseRef), "--release-ref must match release/YYYY.M.PATCH");
  const version = required("--version");
  assert(VERSION_RE.test(version), "--version must be a stable or correction release version");
  const releaseTag = required("--release-tag");
  const baseVersion = releaseNotesVersionForTag(releaseTag);
  const dedicatedVersion = dedicatedSectionVersionForTag(releaseTag);
  assert(
    version === baseVersion || version === dedicatedVersion,
    "--release-tag must match the ledger version",
  );
  return {
    artifactDigest,
    artifactId: positiveInteger(required("--artifact-id"), "--artifact-id"),
    artifactMember,
    artifactName,
    artifactSizeBytes: positiveInteger(required("--artifact-size-bytes"), "--artifact-size-bytes"),
    baseRef: required("--base-ref"),
    manifestSha256: exactSha256(required("--manifest-sha256"), "--manifest-sha256"),
    releaseRef,
    releaseSha: exactSha(required("--release-sha"), "--release-sha"),
    releaseTag,
    repository: required("--repository"),
    runAttempt: positiveInteger(required("--run-attempt"), "--run-attempt"),
    runId: positiveInteger(required("--run-id"), "--run-id"),
    sourceSha: exactSha(required("--source-sha"), "--source-sha"),
    toolingTree: exactSha(required("--tooling-tree"), "--tooling-tree"),
    version,
    workflowSha: exactSha(required("--workflow-sha"), "--workflow-sha"),
  };
}

function parseRunArgs(values) {
  const allowed = new Set([
    "--changelog",
    "--release-sha",
    "--release-tag",
    "--repository",
    "--run-id",
  ]);
  for (const flag of values.keys()) {
    assert(allowed.has(flag), `unknown argument: ${flag}`);
  }
  const required = (flag) => exactString(values.get(flag), flag);
  return {
    changelogPath: values.has("--changelog")
      ? exactString(values.get("--changelog"), "--changelog")
      : "CHANGELOG.md",
    expectedReleaseSha: exactSha(required("--release-sha"), "--release-sha"),
    releaseTag: required("--release-tag"),
    repository: required("--repository"),
    runId: positiveInteger(required("--run-id"), "--run-id"),
  };
}

function parseManifest(bytes) {
  assert(
    Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
    "ledger manifest bytes are required",
  );
  const raw = Buffer.from(bytes);
  assert(raw.length > 0 && raw.length <= 4 * 1024 * 1024, "ledger manifest size is invalid");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(
      `ledger manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "ledger manifest must be an object",
  );
  return { manifest, raw };
}

export function validateReleaseLedgerManifest(bytes, expected) {
  const { manifest, raw } = parseManifest(bytes);
  assert(sha256(raw) === expected.manifestSha256, "ledger manifest SHA-256 mismatch");
  assert(
    JSON.stringify(Object.keys(manifest).toSorted()) === JSON.stringify(EXPECTED_TOP_LEVEL_KEYS),
    "ledger manifest top-level schema mismatch",
  );
  assert(manifest.schemaVersion === 6, "ledger manifest schemaVersion must be 6");
  assert(manifest.status === "pass", "ledger manifest status must be pass");
  assert(manifest.base === expected.baseRef, "ledger manifest base mismatch");
  assert(manifest.version === expected.version, "ledger manifest version mismatch");
  assert(manifest.target === expected.sourceSha, "ledger manifest target mismatch");
  assert(manifest.finalTarget === expected.releaseSha, "ledger manifest finalTarget mismatch");
  assert(manifest.seedAuthorization === null, "ledger manifest must not authorize a seed");

  const invocation = manifest.invocation;
  assert(invocation && typeof invocation === "object", "ledger invocation is missing");
  const { sha256: invocationDigest, ...invocationCore } = invocation;
  assert(
    invocationDigest === sha256(`${JSON.stringify(invocationCore)}\n`),
    "ledger invocation hash is stale",
  );
  assert(invocation.base === expected.baseRef, "ledger invocation base mismatch");
  assert(invocation.target === expected.releaseSha, "ledger invocation target mismatch");
  assert(
    invocation.sourceTarget === expected.sourceSha,
    "ledger invocation source target mismatch",
  );
  assert(invocation.version === expected.version, "ledger invocation version mismatch");
  assert(
    invocation.maxChangelogTail === 1,
    "ledger invocation must allow exactly one changelog commit",
  );
  assert(invocation.comparisonBase === "main", "ledger comparison base must be main");
  assert(invocation.writeLedger === true, "ledger invocation must write the ledger");
  assert(invocation.toolingCommit === expected.workflowSha, "ledger tooling commit mismatch");
  assert(invocation.toolingTree === expected.toolingTree, "ledger tooling tree mismatch");
  assert(
    Array.isArray(invocation.shippedRefs) && invocation.shippedRefs.includes(expected.baseRef),
    "ledger invocation must include the base shipped ref",
  );

  const inventory = manifest.inventory;
  assert(inventory?.schemaVersion === 4, "ledger inventory schemaVersion must be 4");
  assert(inventory.complete === true, "ledger inventory must be complete");
  assert(
    Array.isArray(inventory.unresolved) && inventory.unresolved.length === 0,
    "ledger inventory has unresolved commits",
  );
  const { sha256: inventoryDigest, ...inventoryCore } = inventory;
  assert(
    inventoryDigest === sha256(`${JSON.stringify(inventoryCore)}\n`),
    "ledger inventory hash is stale",
  );
  assert(
    inventory.comparison?.unclassified?.count === 0,
    "ledger comparison has unclassified pull requests",
  );
  for (const field of ["missing", "overlaps", "unexpected"]) {
    assert(
      Array.isArray(inventory.comparison?.partitionAudit?.[field]) &&
        inventory.comparison.partitionAudit[field].length === 0,
      `ledger comparison partition audit ${field} is not empty`,
    );
  }
  for (const field of [
    "generatedMissingRows",
    "generatedUnexpectedRows",
    "missingRows",
    "staleRows",
  ]) {
    assert(
      manifest.reconciliation?.[field]?.count === 0,
      `ledger reconciliation ${field} is not empty`,
    );
  }
  assert(manifest.reconciliation?.coverage === 1, "ledger reconciliation coverage must be 1");
  assert(manifest.reconciliation?.generatedCoverage === 1, "ledger generated coverage must be 1");
  assert(
    manifest.tooling?.trustedSource?.commit === expected.workflowSha &&
      manifest.tooling?.trustedSource?.tree === expected.toolingTree,
    "ledger trusted tooling identity mismatch",
  );
  return manifest;
}

export function validateReleaseLedgerChangelog(manifest, changelog, releaseTag) {
  assert(typeof changelog === "string" && changelog.length > 0, "release changelog is required");
  const baseVersion = releaseNotesVersionForTag(exactString(releaseTag, "release tag"));
  const releaseSection = releaseNotesSectionForTag(changelog, baseVersion, releaseTag);
  const version = releaseSection.match(/^## (?<version>\S+)\r?$/mu)?.groups?.version;
  assert(
    typeof version === "string" && VERSION_RE.test(version),
    "release tag does not select a ledger version",
  );
  const provenance = releaseSection.match(
    /^This audited record covers the complete (?<base>\S+)\.\.(?<source>[0-9a-f]{40}) history: (?:0|[1-9][0-9]*) merged PRs?\./mu,
  );
  assert(provenance?.groups?.base, "release contribution record base is missing");
  assert(provenance?.groups?.source, "release contribution record source is missing");
  assert(manifest.version === version, "ledger version does not match the release tag");
  assert(
    manifest.base === provenance.groups.base,
    "ledger base does not match the release changelog",
  );
  assert(
    manifest.target === provenance.groups.source,
    "ledger source does not match the release changelog",
  );
  assert(
    manifest.artifacts?.changelogSha256 === sha256(Buffer.from(changelog, "utf8")),
    "ledger changelog hash does not match the release tag",
  );
  assert(
    manifest.artifacts?.releaseSectionSha256 === sha256(Buffer.from(releaseSection, "utf8")),
    "ledger release section hash does not match the release tag",
  );
  return {
    baseRef: provenance.groups.base,
    releaseRef: `release/${baseVersion}`,
    sourceSha: provenance.groups.source,
    version,
  };
}

async function githubJson(repository, path, token, fetchImpl, maxBytes = 2 * 1024 * 1024) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "openclaw-release-ledger-validator",
      "x-github-api-version": "2026-03-10",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  assert(response.ok, `GitHub ${path} returned HTTP ${response.status}`);
  const text = await response.text();
  assert(text.length > 0 && text.length <= maxBytes, `GitHub ${path} response is invalid`);
  const value = JSON.parse(text);
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `GitHub ${path} response must be an object`,
  );
  return value;
}

async function resolveRefCommit(repository, ref, token, fetchImpl) {
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  let object = (await githubJson(repository, `git/ref/${encodedRef}`, token, fetchImpl)).object;
  for (let depth = 0; depth < 8; depth += 1) {
    assert(object && SHA_RE.test(object.sha), `GitHub ref ${ref} has an invalid object`);
    if (object.type === "commit") {
      return object.sha;
    }
    assert(object.type === "tag", `GitHub ref ${ref} does not resolve to a commit`);
    object = (await githubJson(repository, `git/tags/${object.sha}`, token, fetchImpl)).object;
  }
  return fail(`GitHub ref ${ref} exceeds the annotated tag depth limit`);
}

async function assertTrustedMainAncestor(repository, workflowSha, token, fetchImpl) {
  const mainSha = await resolveRefCommit(repository, "heads/main", token, fetchImpl);
  const comparison = await githubJson(
    repository,
    `compare/${workflowSha}...${mainSha}`,
    token,
    fetchImpl,
    16 * 1024 * 1024,
  );
  assert(
    comparison.merge_base_commit?.sha === workflowSha,
    "release ledger workflow SHA is not on trusted main",
  );
}

function inspectLedgerArchive(archiveBytes) {
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [ARTIFACT_MEMBER],
    maxArchiveBytes: 8 * 1024 * 1024,
    maxCompressedEntryBytes: () => 4 * 1024 * 1024,
    maxEntryBytes: () => 4 * 1024 * 1024,
    maxExpandedBytes: 4 * 1024 * 1024,
  });
  return files.get(ARTIFACT_MEMBER);
}

async function verifyLiveReleaseRefs(params, fetchImpl) {
  const [branchSha, tagSha] = await Promise.all([
    resolveRefCommit(params.repository, `heads/${params.releaseRef}`, params.token, fetchImpl),
    resolveRefCommit(params.repository, `tags/${params.releaseTag}`, params.token, fetchImpl),
  ]);
  assert(
    branchSha === params.releaseSha,
    "live release branch does not match the ledger release SHA",
  );
  assert(tagSha === params.releaseSha, "release tag does not match the ledger release SHA");
}

export async function consumeReleaseLedgerEvidence(params) {
  assert(params.runAttempt === 1, "release ledger workflow run attempt must be 1");
  const downloaded = await downloadActionsArtifactArchive({
    expected: {
      artifactDigest: params.artifactDigest,
      artifactId: params.artifactId,
      artifactName: params.artifactName,
      artifactSizeBytes: params.artifactSizeBytes,
      repository: params.repository,
      runAttempt: params.runAttempt,
      runId: params.runId,
      runStatePolicy: "completed-success",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: "main",
      workflowPath: WORKFLOW_PATH,
      workflowSha: params.workflowSha,
    },
    fetchImpl: params.fetchImpl,
    maxArchiveBytes: 8 * 1024 * 1024,
    token: params.token,
  });
  const manifest = validateReleaseLedgerManifest(
    inspectLedgerArchive(downloaded.archiveBytes),
    params,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  await verifyLiveReleaseRefs(params, fetchImpl);
  return {
    artifactDigest: params.artifactDigest,
    artifactId: params.artifactId,
    artifactMember: params.artifactMember,
    artifactName: params.artifactName,
    artifactSizeBytes: params.artifactSizeBytes,
    baseRef: params.baseRef,
    manifestSha256: params.manifestSha256,
    releaseRef: params.releaseRef,
    releaseSha: params.releaseSha,
    releaseTag: params.releaseTag,
    repository: params.repository,
    runAttempt: params.runAttempt,
    runId: params.runId,
    sourceSha: params.sourceSha,
    toolingTree: params.toolingTree,
    version: params.version,
    workflowSha: params.workflowSha,
    manifest,
  };
}

export async function consumeReleaseLedgerRunEvidence(params) {
  const repository = exactString(params.repository, "repository");
  const releaseTag = exactString(params.releaseTag, "release tag");
  const expectedReleaseSha = exactSha(params.expectedReleaseSha, "expected release SHA");
  const runId = positiveInteger(params.runId, "release ledger run ID");
  const token = exactString(params.token, "GitHub token");
  const fetchImpl = params.fetchImpl ?? fetch;
  const run = await githubJson(repository, `actions/runs/${runId}`, token, fetchImpl);
  assert(
    run.id === runId &&
      run.run_attempt === 1 &&
      run.head_branch === "main" &&
      SHA_RE.test(run.head_sha ?? "") &&
      run.event === "workflow_dispatch" &&
      run.path === WORKFLOW_PATH &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository,
    "release ledger run is not an exact successful trusted-main attempt-1 producer",
  );
  if (params.isTrustedMainAncestor) {
    assert(
      await params.isTrustedMainAncestor(run.head_sha),
      "release ledger workflow SHA is not on trusted main",
    );
  } else {
    await assertTrustedMainAncestor(repository, run.head_sha, token, fetchImpl);
  }

  const artifactInventory = await githubJson(
    repository,
    `actions/runs/${runId}/artifacts?per_page=100`,
    token,
    fetchImpl,
  );
  assert(
    Number.isSafeInteger(artifactInventory.total_count) &&
      Array.isArray(artifactInventory.artifacts) &&
      artifactInventory.total_count === 1 &&
      artifactInventory.artifacts.length === 1,
    "release ledger artifact inventory is incomplete",
  );
  const artifacts = artifactInventory.artifacts.filter(
    (artifact) => artifact?.name === ARTIFACT_NAME && artifact.expired === false,
  );
  assert(artifacts.length === 1, "release ledger run must have one live evidence artifact");
  const [artifact] = artifacts;
  const artifactId = positiveInteger(artifact.id, "release ledger artifact ID");
  const artifactSizeBytes = positiveInteger(artifact.size_in_bytes, "release ledger artifact size");
  const artifactDigest = exactString(artifact.digest, "release ledger artifact digest");
  assert(DIGEST_RE.test(artifactDigest), "release ledger artifact digest is invalid");
  const downloaded = await downloadActionsArtifactArchive({
    expected: {
      artifactDigest,
      artifactId,
      artifactName: ARTIFACT_NAME,
      artifactSizeBytes,
      repository,
      runAttempt: 1,
      runId,
      runStatePolicy: "completed-success",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: "main",
      workflowPath: WORKFLOW_PATH,
      workflowSha: run.head_sha,
    },
    fetchImpl,
    maxArchiveBytes: 8 * 1024 * 1024,
    token,
  });
  const manifestBytes = inspectLedgerArchive(downloaded.archiveBytes);
  const { manifest } = parseManifest(manifestBytes);
  const changelog = params.changelog;
  assert(typeof changelog === "string" && changelog.length > 0, "release changelog is required");
  const changelogBinding = validateReleaseLedgerChangelog(manifest, changelog, releaseTag);
  const releaseSha = await resolveRefCommit(repository, `tags/${releaseTag}`, token, fetchImpl);
  assert(
    releaseSha === expectedReleaseSha,
    "live release tag does not match the checked-out release SHA",
  );
  const expected = {
    artifactDigest,
    artifactId,
    artifactMember: ARTIFACT_MEMBER,
    artifactName: ARTIFACT_NAME,
    artifactSizeBytes,
    ...changelogBinding,
    manifestSha256: sha256(manifestBytes),
    releaseSha,
    releaseTag,
    repository,
    runAttempt: 1,
    runId,
    toolingTree: exactSha(manifest.tooling?.trustedSource?.tree, "ledger tooling tree"),
    workflowSha: run.head_sha,
  };
  validateReleaseLedgerManifest(manifestBytes, expected);
  await verifyLiveReleaseRefs({ ...expected, token }, fetchImpl);
  return { ...expected, manifest };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseFlagValues(argv);
  const token = exactString(process.env.GH_TOKEN, "GH_TOKEN");
  const runMode = values.size <= 5 && values.has("--run-id");
  const runParams = runMode ? parseRunArgs(values) : undefined;
  const result = runMode
    ? await consumeReleaseLedgerRunEvidence({
        ...runParams,
        changelog: readFileSync(runParams.changelogPath, "utf8"),
        token,
      })
    : await consumeReleaseLedgerEvidence({ ...parseArgs(values), token });
  process.stdout.write(
    `${JSON.stringify({
      artifactDigest: result.artifactDigest,
      artifactId: result.artifactId,
      artifactMember: result.artifactMember,
      artifactName: result.artifactName,
      artifactSizeBytes: result.artifactSizeBytes,
      baseRef: result.baseRef,
      manifestSha256: result.manifestSha256,
      releaseRef: result.releaseRef,
      releaseSha: result.releaseSha,
      releaseTag: result.releaseTag,
      repository: result.repository,
      runAttempt: result.runAttempt,
      runId: result.runId,
      sourceSha: result.sourceSha,
      toolingTree: result.toolingTree,
      version: result.version,
      workflowSha: result.workflowSha,
    })}\n`,
  );
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((/** @type {unknown} */ error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
