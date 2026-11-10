#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fetchNpmRegistryPackumentWithRetry } from "./lib/npm-publish-plan.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";

// Count the complete delta, including release metadata; these are ceilings, not
// a claim that small changes are safe. The release manager owns that decision.
export const EMERGENCY_PATCH_LIMITS = { commits: 3, files: 20, lines: 500 };

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`Emergency patch refused: ${message}`);
  }
}

export function selectEmergencyPatchApproval(policy, releaseTag, npmDistTag) {
  const release = releaseTag?.startsWith("v") ? parseReleaseVersion(releaseTag.slice(1)) : null;
  requireValue(
    npmDistTag === "latest" && release?.channel === "stable" && release.patch < 33,
    "only regular stable/latest patch releases are eligible",
  );
  requireValue(
    policy?.version === 1 && Array.isArray(policy.approvals),
    "invalid checked-in policy",
  );
  const matches = policy.approvals.filter((entry) => entry.releaseTag === releaseTag);
  requireValue(matches.length === 1, "exactly one checked-in release-manager approval is required");
  const approval = matches[0];
  const base =
    typeof approval.baseTag === "string" && approval.baseTag.startsWith("v")
      ? parseReleaseVersion(approval.baseTag.slice(1))
      : null;
  requireValue(
    base?.channel === "stable" &&
      base.patch < 33 &&
      base.year === release.year &&
      base.month === release.month &&
      ((release.patch === base.patch + 1 && release.correctionNumber === undefined) ||
        (release.patch === base.patch &&
          release.correctionNumber === (base.correctionNumber ?? 0) + 1)),
    "candidate must be the next patch or correction of the same regular stable train",
  );
  requireValue(
    [approval.baseSha, approval.candidateSha].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha),
    ),
    "exact base and candidate SHAs are required",
  );
  requireValue(
    typeof approval.reason === "string" && approval.reason.trim().length >= 20,
    "approval must explain the emergency and accepted validation risk",
  );
  return approval;
}

function inspectEmergencyPatchDelta(root, approval) {
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  git(["merge-base", "--is-ancestor", approval.baseSha, approval.candidateSha]);
  const commits = Number(
    git(["rev-list", "--count", `${approval.baseSha}..${approval.candidateSha}`]).trim(),
  );
  const stats = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    "-z",
    approval.baseSha,
    approval.candidateSha,
  ]);
  const files = stats
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+)\t(\d+)\t([\s\S]+)$/u.exec(row);
      requireValue(match, "binary changes are not eligible");
      return { path: match[3], added: Number(match[1]), deleted: Number(match[2]) };
    });
  const lines = files.reduce((total, file) => total + file.added + file.deleted, 0);
  requireValue(
    commits > 0 &&
      commits <= EMERGENCY_PATCH_LIMITS.commits &&
      files.length > 0 &&
      files.length <= EMERGENCY_PATCH_LIMITS.files &&
      lines <= EMERGENCY_PATCH_LIMITS.lines,
    "complete base-to-candidate delta exceeds the small-patch budget",
  );
  return {
    commits,
    files,
    lines,
    sha256: createHash("sha256")
      .update(
        git([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--binary",
          approval.baseSha,
          approval.candidateSha,
        ]),
      )
      .digest("hex"),
  };
}

function api(path) {
  return JSON.parse(
    execFileSync("gh", ["api", `repos/openclaw/openclaw/${path}`], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

function signedTag(tag, expectedSha, readApi) {
  const ref = readApi(`git/ref/tags/${tag}`);
  requireValue(ref.object?.type === "tag", `${tag} must be annotated and signed`);
  const object = readApi(`git/tags/${ref.object.sha}`);
  requireValue(
    object.tag === tag &&
      object.object?.type === "commit" &&
      object.object.sha === expectedSha &&
      object.verification?.verified === true,
    `${tag} must have a verified signature and resolve to the approved SHA`,
  );
}

async function readRegistry() {
  return await fetchNpmRegistryPackumentWithRetry({
    packageName: "openclaw",
    packageUrl: "https://registry.npmjs.org/openclaw",
    maxBytes: 16 * 1024 * 1024,
    timeoutMs: 15000,
    attempts: 2,
    redirect: "manual",
  });
}

export async function qualifyEmergencyPatch({
  root,
  policy,
  releaseTag,
  npmDistTag,
  expectedSha,
  registryReader = readRegistry,
  readApi = api,
}) {
  const approval = selectEmergencyPatchApproval(policy, releaseTag, npmDistTag);
  requireValue(approval.candidateSha === expectedSha, "publication target differs from approval");
  const registry = await registryReader();
  requireValue(
    registry.ok &&
      [approval.baseTag.slice(1), approval.releaseTag.slice(1)].includes(
        registry.packument?.["dist-tags"]?.latest,
      ),
    "approved baseline is no longer the published npm latest release",
  );
  // The candidate itself permits retrying postpublish recovery. Existing exact-byte
  // and provenance checks still own reuse; this does not authorize republishing it.
  signedTag(approval.baseTag, approval.baseSha, readApi);
  signedTag(approval.releaseTag, approval.candidateSha, readApi);
  // Fetch exact immutable objects, never a moving branch or candidate script.
  const shallow =
    execFileSync("git", ["-C", root, "rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
    }).trim() === "true";
  execFileSync(
    "git",
    [
      "-C",
      root,
      "fetch",
      "--no-tags",
      ...(shallow ? ["--unshallow"] : []),
      "origin",
      approval.baseSha,
      approval.candidateSha,
    ],
    { stdio: "inherit" },
  );
  const delta = inspectEmergencyPatchDelta(root, approval);
  return {
    version: 1,
    mode: "emergency-patch-v1",
    approval,
    delta,
    skipped: [
      "full-release-validation",
      "source-ci",
      "cross-os-validation",
      "live-providers",
      "soak",
      "performance",
    ],
    retained: [
      "signed-tags",
      "npm-preflight",
      "exact-byte-integrity",
      "npm-release-environment-approval",
      "postpublish-verification",
    ],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: "." },
      tag: { type: "string" },
      "npm-dist-tag": { type: "string" },
      "expected-sha": { type: "string" },
      output: { type: "string" },
    },
  });
  const policy = JSON.parse(
    readFileSync(new URL("./release-emergency-patch-policy.json", import.meta.url), "utf8"),
  );
  const evidence = await qualifyEmergencyPatch({
    root: values.root,
    policy,
    releaseTag: values.tag,
    npmDistTag: values["npm-dist-tag"],
    expectedSha: values["expected-sha"],
  });
  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
