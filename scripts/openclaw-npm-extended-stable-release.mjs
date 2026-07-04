#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const SUPPORTED_DIST_TAGS = new Set(["alpha", "beta", "latest", "extended-stable"]);

export function parseExtendedStableGuardBypass(value = "") {
  if (value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`BYPASS_EXTENDED_STABLE_GUARD must be "true" or "false"; got "${value}".`);
}

function requireExtendedStableBypassTag(npmDistTag, bypassExtendedStableGuard) {
  if (bypassExtendedStableGuard && npmDistTag !== "extended-stable") {
    throw new Error(
      "BYPASS_EXTENDED_STABLE_GUARD may only be used with the extended-stable npm dist-tag.",
    );
  }
}

export function validateNpmPublishBoundary(
  packageVersion,
  npmDistTag,
  { bypassExtendedStableGuard = false } = {},
) {
  if (!SUPPORTED_DIST_TAGS.has(npmDistTag)) {
    throw new Error(`Unsupported npm dist-tag "${npmDistTag}".`);
  }
  requireExtendedStableBypassTag(npmDistTag, bypassExtendedStableGuard);
  const parsed = parseReleaseVersion(packageVersion);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${packageVersion}".`);
  }

  if (parsed.channel === "alpha") {
    if (npmDistTag !== "alpha") {
      throw new Error("Alpha prereleases must publish to the alpha npm dist-tag.");
    }
    return parsed;
  }
  if (parsed.channel === "beta") {
    if (npmDistTag !== "beta") {
      throw new Error("Beta prereleases must publish to the beta npm dist-tag.");
    }
    return parsed;
  }

  if (npmDistTag === "extended-stable") {
    if (parsed.correctionNumber !== undefined) {
      throw new Error("Extended-stable npm publication does not allow correction suffixes.");
    }
    if (!bypassExtendedStableGuard && parsed.patch < 33) {
      throw new Error("Extended-stable npm publication requires release patch 33 or above.");
    }
    return parsed;
  }
  if (parsed.patch >= 33) {
    throw new Error(
      `Final or correction release patch 33 and above must publish to the extended-stable npm dist-tag; got ${npmDistTag}.`,
    );
  }
  return parsed;
}

export function extendedStableCandidateTag(packageVersion) {
  const parsed = parseReleaseVersion(packageVersion.replace(/^v/u, ""));
  if (parsed === null || parsed.channel !== "stable" || parsed.correctionNumber !== undefined) {
    throw new Error("Extended-stable candidate tags require an exact final YYYY.M.P version.");
  }
  return `extended-stable-candidate-${parsed.year}-${parsed.month}-${parsed.patch}`;
}

export function resolveNpmPublishTag(packageVersion, requestedTag, options = {}) {
  validateNpmPublishBoundary(packageVersion, requestedTag, options);
  return requestedTag === "extended-stable"
    ? extendedStableCandidateTag(packageVersion)
    : requestedTag;
}

export function validateExtendedStableNpmReleaseRequest(request) {
  const bypassExtendedStableGuard = request.bypassExtendedStableGuard ?? false;
  requireExtendedStableBypassTag(request.npmDistTag, bypassExtendedStableGuard);
  const taggedVersion = request.releaseTag.startsWith("v")
    ? parseReleaseVersion(request.releaseTag.slice(1))
    : null;

  if (request.npmDistTag !== "extended-stable") {
    if (taggedVersion !== null) {
      validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, {
        bypassExtendedStableGuard,
      });
    } else if (!SUPPORTED_DIST_TAGS.has(request.npmDistTag)) {
      throw new Error(`Unsupported npm dist-tag "${request.npmDistTag}".`);
    }
    return { extendedStable: false };
  }

  if (
    taggedVersion === null ||
    request.releaseTag !== `v${taggedVersion.version}` ||
    taggedVersion.channel !== "stable"
  ) {
    throw new Error(
      "Extended-stable npm publication requires an exact final vYYYY.M.P release tag.",
    );
  }
  validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, {
    bypassExtendedStableGuard,
  });

  const releaseVersion = taggedVersion.version;
  const extendedStableBranch = `extended-stable/${taggedVersion.year}.${taggedVersion.month}.33`;
  const expectedWorkflowRef = `refs/heads/${extendedStableBranch}`;
  if (request.npmWorkflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Extended-stable npm workflow ref mismatch: expected ${expectedWorkflowRef}, got ${request.npmWorkflowRef}.`,
    );
  }
  if (request.packageVersion !== releaseVersion) {
    throw new Error(
      `Extended-stable npm package version mismatch: expected ${releaseVersion}, got ${request.packageVersion}.`,
    );
  }

  const shaValues = [request.checkoutSha, request.tagSha, request.extendedStableBranchSha];
  if (shaValues.some((sha) => !/^[0-9a-f]{40}$/iu.test(sha))) {
    throw new Error("Extended-stable npm release identity requires full 40-character Git SHAs.");
  }
  if (new Set(shaValues.map((sha) => sha.toLowerCase())).size !== 1) {
    throw new Error("Extended-stable npm checkout, tag, and branch tip SHAs must match exactly.");
  }

  if (bypassExtendedStableGuard) {
    return {
      extendedStable: true,
      releaseVersion,
      extendedStableBranch,
      bypassExtendedStableGuard: true,
    };
  }

  const mainVersion = parseReleaseVersion(request.mainPackageVersion);
  if (
    mainVersion === null ||
    mainVersion.channel !== "stable" ||
    mainVersion.correctionNumber !== undefined
  ) {
    throw new Error("Protected main package version must be an exact final YYYY.M.P version.");
  }
  const mainCalendarMonth = mainVersion.year * 12 + mainVersion.month;
  const releaseCalendarMonth = taggedVersion.year * 12 + taggedVersion.month;
  if (mainCalendarMonth <= releaseCalendarMonth) {
    throw new Error(
      `Protected main must be in a later calendar month than ${taggedVersion.year}.${taggedVersion.month}; got ${request.mainPackageVersion}.`,
    );
  }
  if (mainVersion.patch >= 33) {
    throw new Error("Protected main must remain on a daily patch below 33.");
  }
  return { extendedStable: true, releaseVersion, extendedStableBranch };
}

export function validateExtendedStableRunIdentity({
  run,
  kind,
  npmDistTag,
  expectedBranch,
  expectedSha,
}) {
  const expectedWorkflowName =
    kind === "preflight" ? "OpenClaw NPM Release" : "Full Release Validation";
  const checks = [
    ["workflowName", expectedWorkflowName],
    ["event", "workflow_dispatch"],
    ...(kind === "validation" ? [["status", "completed"]] : []),
    ["conclusion", "success"],
  ];
  for (const [key, expected] of checks) {
    if (run[key] !== expected) {
      throw new Error(
        `Referenced ${kind} run must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
      );
    }
  }
  if (
    npmDistTag === "extended-stable" &&
    (run.headBranch !== expectedBranch || run.headSha !== expectedSha)
  ) {
    throw new Error(
      `Referenced extended-stable ${kind} run must have headBranch=${expectedBranch} and headSha=${expectedSha}; got ${run.headBranch ?? "<missing>"} and ${run.headSha ?? "<missing>"}.`,
    );
  }
  return run;
}

export function validateFullReleaseValidationManifest({
  manifest,
  npmDistTag,
  expectedWorkflowRef,
  expectedSha,
}) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(
      `Full release validation manifest workflow mismatch: ${manifest.workflowName ?? "<missing>"}.`,
    );
  }
  if (manifest.targetSha !== expectedSha) {
    throw new Error(
      `Full release validation target SHA mismatch: expected ${expectedSha}, got ${manifest.targetSha ?? "<missing>"}.`,
    );
  }
  if (npmDistTag === "extended-stable" && manifest.workflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Full release validation workflow ref mismatch: expected ${expectedWorkflowRef}, got ${manifest.workflowRef ?? "<missing>"}.`,
    );
  }
  return manifest;
}

export async function verifyExtendedStableCandidateReadback({
  expectedVersion,
  packageName = "openclaw",
  query,
  sleep,
  attempts = 12,
  delayMs = 10_000,
}) {
  const candidateTag = extendedStableCandidateTag(expectedVersion);
  let exactVersion = "missing";
  let candidateVersion = "missing";
  let integrity = "missing";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [exactResult, candidateResult, integrityResult] = await Promise.all([
      query(`${packageName}@${expectedVersion}`, "version"),
      query(`${packageName}@${candidateTag}`, "version"),
      query(`${packageName}@${expectedVersion}`, "dist.integrity"),
    ]);
    exactVersion = exactResult.status === 0 ? exactResult.stdout.trim() : "missing";
    candidateVersion = candidateResult.status === 0 ? candidateResult.stdout.trim() : "missing";
    integrity = integrityResult.status === 0 ? integrityResult.stdout.trim() : "missing";
    if (
      exactVersion === expectedVersion &&
      candidateVersion === expectedVersion &&
      integrity.startsWith("sha512-")
    ) {
      return { exactVersion, candidateVersion, candidateTag, integrity, attemptsUsed: attempt };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw new Error(
    `npm registry did not converge to ${packageName}@${expectedVersion} under ${candidateTag} after ${attempts} attempts (exact=${exactVersion}, candidate=${candidateVersion}, integrity=${integrity}).`,
  );
}

export function buildExtendedStableCorePublicationResult(input) {
  const candidateTag = extendedStableCandidateTag(input.version);
  const result = {
    schemaVersion: 1,
    package: {
      name: "openclaw",
      version: input.version,
      integrity: input.integrity,
      candidateTag,
    },
    source: {
      repository: input.repository,
      sha: input.sourceSha,
    },
    workflow: {
      repository: input.repository,
      path: ".github/workflows/openclaw-npm-release.yml",
      ref: input.workflowRef,
      runId: input.runId,
      runAttempt: input.runAttempt,
    },
    conclusion: "succeeded",
  };
  if (!/^[0-9a-f]{40}$/u.test(result.source.sha)) {
    throw new Error("Core publication source SHA must be 40 lowercase hex characters.");
  }
  if (!result.package.integrity.startsWith("sha512-")) {
    throw new Error("Core publication integrity must be an npm sha512 integrity.");
  }
  if (!result.workflow.ref.startsWith("refs/heads/")) {
    throw new Error("Core publication workflow ref must be a branch ref.");
  }
  if (!Number.isSafeInteger(result.workflow.runId) || result.workflow.runId <= 0) {
    throw new Error("Core publication run id must be a positive integer.");
  }
  if (!Number.isSafeInteger(result.workflow.runAttempt) || result.workflow.runAttempt <= 0) {
    throw new Error("Core publication run attempt must be a positive integer.");
  }
  return result;
}

function assertClosedObject(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const actualKeys = Object.keys(value).toSorted();
  const sortedExpectedKeys = [...expectedKeys].toSorted();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${label} has an unexpected field set.`);
  }
}

export function verifyExtendedStableCorePublicationResult(value, expected) {
  assertClosedObject(
    value,
    ["schemaVersion", "package", "source", "workflow", "conclusion"],
    "Core publication result",
  );
  assertClosedObject(
    value.package,
    ["name", "version", "integrity", "candidateTag"],
    "Core publication result package",
  );
  assertClosedObject(value.source, ["repository", "sha"], "Core publication result source");
  assertClosedObject(
    value.workflow,
    ["repository", "path", "ref", "runId", "runAttempt"],
    "Core publication result workflow",
  );
  const normalizedVersion = (expected.version ?? "").replace(/^v/u, "");
  const checks = [
    ["schemaVersion", value.schemaVersion, 1],
    ["package.name", value.package.name, "openclaw"],
    ["package.version", value.package.version, normalizedVersion],
    [
      "package.candidateTag",
      value.package.candidateTag,
      extendedStableCandidateTag(normalizedVersion),
    ],
    ["source.repository", value.source.repository, expected.repository],
    ["source.sha", value.source.sha, expected.sourceSha],
    ["workflow.repository", value.workflow.repository, expected.repository],
    ["workflow.path", value.workflow.path, ".github/workflows/openclaw-npm-release.yml"],
    ["workflow.ref", value.workflow.ref, expected.workflowRef],
    ["workflow.runId", value.workflow.runId, expected.runId],
    ["workflow.runAttempt", value.workflow.runAttempt, expected.runAttempt],
    ["conclusion", value.conclusion, "succeeded"],
  ];
  for (const [label, actual, wanted] of checks) {
    if (actual !== wanted) {
      throw new Error(
        `Core publication result ${label} mismatch: expected ${String(wanted)}, got ${String(actual)}.`,
      );
    }
  }
  if (
    typeof value.package.integrity !== "string" ||
    !value.package.integrity.startsWith("sha512-")
  ) {
    throw new Error("Core publication result package.integrity must be an npm sha512 integrity.");
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function packageVersionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function validateRequestFromRepository() {
  const npmDistTag = process.env.RELEASE_NPM_DIST_TAG ?? "";
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const npmWorkflowRef = process.env.NPM_WORKFLOW_REF ?? "";
  const bypassExtendedStableGuard = parseExtendedStableGuardBypass(
    process.env.BYPASS_EXTENDED_STABLE_GUARD ?? "",
  );
  if (npmDistTag !== "extended-stable") {
    return validateExtendedStableNpmReleaseRequest({
      bypassExtendedStableGuard,
      npmDistTag,
      releaseTag,
      npmWorkflowRef,
      checkoutSha: "",
      tagSha: "",
      extendedStableBranchSha: "",
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }

  const parsed = releaseTag.startsWith("v") ? parseReleaseVersion(releaseTag.slice(1)) : null;
  if (!parsed || parsed.channel !== "stable" || parsed.correctionNumber !== undefined) {
    return validateExtendedStableNpmReleaseRequest({
      npmDistTag,
      bypassExtendedStableGuard,
      releaseTag,
      npmWorkflowRef,
      checkoutSha: "",
      tagSha: "",
      extendedStableBranchSha: "",
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }
  const extendedStableBranch = `extended-stable/${parsed.year}.${parsed.month}.33`;
  if (bypassExtendedStableGuard) {
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${extendedStableBranch}:refs/remotes/origin/${extendedStableBranch}`,
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "git",
      ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
      { stdio: "inherit" },
    );
    return validateExtendedStableNpmReleaseRequest({
      npmDistTag,
      bypassExtendedStableGuard,
      releaseTag,
      npmWorkflowRef,
      checkoutSha: git(["rev-parse", "HEAD"]),
      tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
      extendedStableBranchSha: git(["rev-parse", `refs/remotes/origin/${extendedStableBranch}`]),
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${extendedStableBranch}:refs/remotes/origin/${extendedStableBranch}`,
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
    { stdio: "inherit" },
  );
  return validateExtendedStableNpmReleaseRequest({
    npmDistTag,
    bypassExtendedStableGuard,
    releaseTag,
    npmWorkflowRef,
    checkoutSha: git(["rev-parse", "HEAD"]),
    tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
    extendedStableBranchSha: git(["rev-parse", `refs/remotes/origin/${extendedStableBranch}`]),
    packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    mainPackageVersion: packageVersionAt("refs/remotes/origin/main"),
  });
}

function appendOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "validate-request") {
    const result = validateRequestFromRepository();
    console.log(
      result.extendedStable
        ? `Validated extended-stable npm release ${result.releaseVersion}.`
        : "Validated regular npm release request.",
    );
    return;
  }
  if (command === "publish-plan") {
    const npmDistTag = process.env.REQUESTED_PUBLISH_TAG ?? "";
    const bypassExtendedStableGuard = parseExtendedStableGuardBypass(
      process.env.BYPASS_EXTENDED_STABLE_GUARD ?? "",
    );
    const packageVersion = process.env.PACKAGE_VERSION ?? "";
    const parsed = validateNpmPublishBoundary(packageVersion, npmDistTag, {
      bypassExtendedStableGuard,
    });
    console.log(parsed.channel);
    console.log(
      resolveNpmPublishTag(packageVersion, npmDistTag, {
        bypassExtendedStableGuard,
      }),
    );
    return;
  }
  if (command === "verify-run") {
    const run = JSON.parse(readFileSync(0, "utf8"));
    validateExtendedStableRunIdentity({
      run,
      kind: process.env.RUN_KIND,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedBranch: process.env.EXPECTED_EXTENDED_STABLE_BRANCH,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    console.log(`Verified referenced ${process.env.RUN_KIND} run.`);
    return;
  }
  if (command === "verify-manifest") {
    const manifest = JSON.parse(readFileSync(process.env.MANIFEST_FILE, "utf8"));
    validateFullReleaseValidationManifest({
      manifest,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedWorkflowRef: process.env.EXPECTED_WORKFLOW_REF,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    return;
  }
  if (command === "verify-candidate-readback") {
    const expectedVersion = (process.env.EXPECTED_VERSION ?? "").replace(/^v/u, "");
    const result = await verifyExtendedStableCandidateReadback({
      expectedVersion,
      packageName: process.env.NPM_PACKAGE_NAME ?? "openclaw",
      query: (target, field) => spawnSync("npm", ["view", target, field], { encoding: "utf8" }),
      sleep: (delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    });
    appendOutput({
      exact_version: result.exactVersion,
      candidate_version: result.candidateVersion,
      candidate_tag: result.candidateTag,
      integrity: result.integrity,
    });
    return;
  }
  if (command === "write-publication-result") {
    const result = buildExtendedStableCorePublicationResult({
      version: (process.env.EXPECTED_VERSION ?? "").replace(/^v/u, ""),
      integrity: process.env.PACKAGE_INTEGRITY ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      sourceSha: process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? "",
      workflowRef: process.env.GITHUB_REF ?? "",
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "verify-publication-result") {
    const resultPath = process.env.CORE_PUBLICATION_RESULT_FILE ?? "";
    if (!resultPath) {
      throw new Error("CORE_PUBLICATION_RESULT_FILE is required.");
    }
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    verifyExtendedStableCorePublicationResult(result, {
      version: process.env.EXPECTED_VERSION ?? "",
      repository: process.env.EXPECTED_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "",
      sourceSha: process.env.EXPECTED_SOURCE_SHA ?? "",
      workflowRef: process.env.EXPECTED_WORKFLOW_REF ?? "",
      runId: Number(process.env.EXPECTED_RUN_ID),
      runAttempt: Number(process.env.EXPECTED_RUN_ATTEMPT),
    });
    console.log(`Verified core publication result for openclaw@${result.package.version}.`);
    return;
  }
  throw new Error(`Unknown extended-stable npm release command: ${command ?? "<missing>"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw-npm-extended-stable-release: ${message}`);
    process.exit(1);
  }
}
