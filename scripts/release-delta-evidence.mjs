#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execPlainGh, spawnPlainGh } from "./lib/plain-gh.mjs";
import {
  computeTargetClawHubRosterAudit,
  computeTrustBundle,
  createReleaseDeltaEvidence,
  parsePositiveDecimalId,
  parseReleaseDeltaPolicy,
  resolveRemoteTagState,
  validateReleaseDelta,
  validateReleaseDeltaManifest,
  validateReleaseDeltaPolicyPath,
} from "./lib/release-delta-evidence.mjs";
import { renderGithubReleaseNotes } from "./render-github-release-notes.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, args, encoding = "utf8") =>
  execFileSync("git", args, { cwd, encoding, maxBuffer: 128 * 1024 * 1024 });

function fail(message) {
  throw new Error(`Usage: release-delta-evidence.mjs <create|verify> [options]\n${message}`);
}

export function parseReleaseDeltaArgs(argv) {
  const command = argv.shift();
  if (!["create", "verify"].includes(command)) fail("Expected create or verify.");
  const create = [
    "policy",
    "target-ref",
    "evidence-runs",
    "release-notes-verification",
    "workflow-sha",
    "output",
  ];
  const verify = ["tag", "npm-preflight-run", "run-id"];
  const required = ["repo", "target-sha", ...(command === "create" ? create : verify)];
  const names = [...required, "github-output"];
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      strict: true,
    }).values;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const name of required) {
    if (!values[name]) fail(`--${name} is required.`);
  }
  return {
    command,
    ...Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase()),
        value,
      ]),
    ),
  };
}

const githubApi = (apiPath) =>
  JSON.parse(execPlainGh(["api", apiPath], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }));

function githubApiOptional(apiPath) {
  const result = spawnPlainGh(["api", apiPath], { encoding: "utf8" });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/HTTP 404|Not Found/iu.test(result.stderr ?? "")) return null;
  throw new Error(`GitHub API request failed: ${apiPath}\n${result.stderr ?? ""}`);
}

function evidenceReader(repo, root) {
  const zips = new Map();
  const entriesCache = new Map();
  function zip(artifact) {
    if (!zips.has(artifact.id)) {
      const file = path.join(root, `${artifact.id}.zip`);
      const fd = openSync(file, "w", 0o600);
      const result = spawnPlainGh(["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], {
        stdio: ["ignore", fd, "inherit"],
      });
      closeSync(fd);
      if (result.status !== 0) throw new Error(`Failed to download artifact ${artifact.id}.`);
      const digest = `sha256:${sha256(readFileSync(file))}`;
      if (digest !== artifact.digest) {
        throw new Error(`Artifact ${artifact.id} ZIP digest differs from GitHub metadata.`);
      }
      zips.set(artifact.id, file);
    }
    return zips.get(artifact.id);
  }
  function entries(artifact) {
    if (!entriesCache.has(artifact.id)) {
      const values = execFileSync("unzip", ["-Z1", zip(artifact)], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
      if (
        values.length === 0 ||
        new Set(values).size !== values.length ||
        values.some(
          (entry) =>
            path.posix.isAbsolute(entry) || entry.split("/").includes("..") || entry.includes("\\"),
        )
      ) {
        throw new Error(`Artifact ${artifact.id} contains an unsafe ZIP inventory.`);
      }
      entriesCache.set(artifact.id, values);
    }
    return entriesCache.get(artifact.id);
  }
  function bytes(artifact, entry) {
    if (!entries(artifact).includes(entry)) {
      throw new Error(`Artifact ${artifact.id} is missing ${entry}.`);
    }
    return execFileSync("unzip", ["-p", zip(artifact), entry], {
      maxBuffer: 256 * 1024 * 1024,
    });
  }
  return {
    verifyArtifact: async (artifact) => {
      zip(artifact);
    },
    artifactEntries: async (artifact) => entries(artifact),
    artifactBytes: async (artifact, entry) => bytes(artifact, entry),
    jobLog: async (jobId) =>
      execPlainGh(["api", `repos/${repo}/actions/jobs/${jobId}/logs`], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      }),
  };
}

function canonicalPolicy(raw) {
  const policy = parseReleaseDeltaPolicy(raw);
  return { policy, bytes: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) };
}

function writeOutputs(file, result) {
  if (!file) return;
  const values = {
    manifest_path: result.manifestPath,
    artifact_id: result.artifactId,
    artifact_digest: result.artifactDigest,
    manifest_sha256: result.manifestSha256,
    target_npm_run_id: result.targetNpmRunId,
    target_npm_artifact_id: result.targetNpmArtifactId,
    target_npm_artifact_digest: result.targetNpmArtifactDigest,
    target_root_tarball_name: result.targetRootTarballName,
    target_root_tarball_sha256: result.targetRootTarballSha256,
    target_ai_tarball_name: result.targetAiTarballName,
    target_ai_tarball_sha256: result.targetAiTarballSha256,
  };
  writeFileSync(
    file,
    `${Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { flag: "a" },
  );
}

function resultFor(manifest, manifestPath, artifact = {}) {
  const target = manifest.packageEvidence.target;
  return {
    sourceSha: manifest.sourceSha,
    targetSha: manifest.targetSha,
    mode: "release-delta-reuse-v3",
    manifestPath,
    targetNpmRunId: target.run.id,
    targetNpmArtifactId: target.artifact.id,
    targetNpmArtifactDigest: target.artifact.digest,
    targetRootTarballName: target.root.name,
    targetRootTarballSha256: target.root.sha256,
    targetAiTarballName: target.ai.name,
    targetAiTarballSha256: target.ai.sha256,
    ...artifact,
  };
}

export async function createReleaseDelta(options, overrides = {}) {
  const cwd = overrides.cwd ?? process.cwd();
  const policyPath = path.resolve(cwd, options.policy);
  const { policy, bytes: policyBytes } = canonicalPolicy(readFileSync(policyPath));
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-release-delta-"));
  const readers = overrides.readers ?? evidenceReader(options.repo, tempDir);
  const manifest = await createReleaseDeltaEvidence(
    {
      cwd,
      tempDir,
      targetRef: options.targetRef,
      targetSha: options.targetSha,
      policy,
      policyPath: path.relative(cwd, policyPath).split(path.sep).join("/"),
      policySha256: sha256(policyBytes),
      evidenceRuns: readFileSync(options.evidenceRuns, "utf8"),
      releaseNotesVerification: readFileSync(options.releaseNotesVerification, "utf8"),
      workflowSha: options.workflowSha,
      producer: {
        runId: parsePositiveDecimalId(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
        runAttempt: parsePositiveDecimalId(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        workflowSha: options.workflowSha,
        ref: process.env.GITHUB_REF,
      },
    },
    {
      repo: options.repo,
      api: overrides.api ?? githubApi,
      apiOptional: overrides.apiOptional ?? githubApiOptional,
      ...readers,
    },
  );
  if (manifest.policy.sha256 !== sha256(policyBytes)) {
    throw new Error("Created manifest policy digest differs from the checked-in policy.");
  }
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  return resultFor(manifest, options.output);
}

async function producerArtifact(runId, repo, api) {
  const response = await api(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const name = `release-delta-evidence-${runId}-1`;
  const matches = (response.artifacts ?? []).filter(
    (artifact) =>
      artifact.name === name &&
      artifact.workflow_run?.id === runId &&
      artifact.expired === false &&
      /^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? ""),
  );
  if (matches.length !== 1) throw new Error(`Run ${runId} must contain one immutable ${name}.`);
  return matches[0];
}

function untrustedManifestPolicy(document) {
  const value = document?.policy;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(["blobSha", "path", "sha256"])
  ) {
    throw new Error("Release delta manifest policy metadata is invalid.");
  }
  validateReleaseDeltaPolicyPath(value.path);
  if (!/^[0-9a-f]{40}$/u.test(value.blobSha ?? "") || !/^[0-9a-f]{64}$/u.test(value.sha256 ?? "")) {
    throw new Error("Release delta manifest policy identity is invalid.");
  }
  return value;
}

async function verifyPromotablePackage(manifest, options, api, readers) {
  const target = manifest.packageEvidence.target;
  const artifact = await api(`repos/${options.repo}/actions/artifacts/${target.artifact.id}`);
  if (
    artifact.id !== target.artifact.id ||
    artifact.name !== target.artifact.name ||
    artifact.digest !== target.artifact.digest ||
    artifact.workflow_run?.id !== target.run.id ||
    artifact.expired !== false
  ) {
    throw new Error("Promotable npm artifact metadata differs from the manifest.");
  }
  await readers.verifyArtifact(artifact);
  const manifestRaw = await readers.artifactBytes(artifact, "preflight-manifest.json");
  const packageManifest = JSON.parse(manifestRaw.toString("utf8"));
  const dependency = packageManifest.dependencyTarballs?.[0];
  if (
    packageManifest.releaseSha !== manifest.targetSha ||
    packageManifest.releaseTag !== manifest.releaseTag ||
    packageManifest.tarballName !== target.root.name ||
    packageManifest.tarballSha256 !== target.root.sha256 ||
    dependency?.packageName !== "@openclaw/ai" ||
    dependency.tarballName !== target.ai.name ||
    dependency.tarballSha256 !== target.ai.sha256
  ) {
    throw new Error("Promotable npm manifest differs from the verified delta evidence.");
  }
  const [root, ai] = await Promise.all([
    readers.artifactBytes(artifact, target.root.name),
    readers.artifactBytes(artifact, target.ai.name),
  ]);
  if (sha256(root) !== target.root.sha256 || sha256(ai) !== target.ai.sha256) {
    throw new Error("Promotable npm tarball bytes differ from the verified delta evidence.");
  }
}

export async function verifyReleaseDelta(options, overrides = {}) {
  const cwd = overrides.cwd ?? process.cwd();
  const api = overrides.api ?? githubApi;
  const apiOptional = overrides.apiOptional ?? githubApiOptional;
  const runId = parsePositiveDecimalId(options.runId, "run id");
  const npmRunId = parsePositiveDecimalId(options.npmPreflightRun, "npm preflight run id");
  const run = await api(`repos/${options.repo}/actions/runs/${runId}`);
  if (
    run?.id !== runId ||
    run.name !== "Release Delta Evidence" ||
    run.path !== ".github/workflows/release-delta-evidence.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1
  ) {
    throw new Error(`Release Delta Evidence run ${runId} is not trusted-main attempt 1.`);
  }
  const artifact = await producerArtifact(runId, options.repo, api);
  const outputDir =
    overrides.outputDir ?? path.resolve(cwd, ".artifacts", "release-delta-evidence", String(runId));
  mkdirSync(outputDir, { recursive: true });
  const readers = overrides.readers ?? evidenceReader(options.repo, outputDir);
  await readers.verifyArtifact(artifact);
  const entries = await readers.artifactEntries(artifact);
  if (JSON.stringify(entries) !== JSON.stringify(["release-delta-evidence.json"])) {
    throw new Error(
      "Release delta evidence artifact must contain only release-delta-evidence.json.",
    );
  }
  const raw = await readers.artifactBytes(artifact, "release-delta-evidence.json");
  const manifestPath = path.join(outputDir, "release-delta-evidence.json");
  writeFileSync(manifestPath, raw);
  const untrustedManifest = JSON.parse(raw.toString("utf8"));
  const policyIdentity = untrustedManifestPolicy(untrustedManifest);
  execFileSync("git", ["fetch", "--no-tags", "origin", run.head_sha], { cwd });
  const policyBlobBytes = git(cwd, ["show", `${run.head_sha}:${policyIdentity.path}`], "buffer");
  const policyBlobSha = git(cwd, ["rev-parse", `${run.head_sha}:${policyIdentity.path}`]).trim();
  if (
    policyIdentity.sha256 !== sha256(policyBlobBytes) ||
    policyIdentity.blobSha !== policyBlobSha
  ) {
    throw new Error("Release delta manifest policy blob identity differs.");
  }
  const policy = parseReleaseDeltaPolicy(policyBlobBytes);
  const manifest = validateReleaseDeltaManifest(untrustedManifest, policy, {
    releaseTag: options.tag,
    targetSha: options.targetSha,
  });
  if (
    manifest.producer.runId !== runId ||
    manifest.producer.workflowSha !== run.head_sha ||
    manifest.packageEvidence.target.run.id !== npmRunId
  ) {
    throw new Error("Manifest policy, producer, or promotable npm identity differs.");
  }

  const revisions = [policy.git.baselineSha, policy.git.sourceSha, manifest.producer.workflowSha];
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${manifest.targetRef}:refs/remotes/origin/${manifest.targetRef}`,
    ],
    { cwd },
  );
  execFileSync("git", ["fetch", "--no-tags", "origin", ...revisions], { cwd });
  const delta = validateReleaseDelta(cwd, policy, manifest.targetSha);
  if (
    delta.parentSha !== manifest.parentSha ||
    JSON.stringify(delta.changedPaths) !== JSON.stringify(manifest.changedPaths) ||
    JSON.stringify(delta.touchedPaths) !== JSON.stringify(manifest.touchedPaths) ||
    JSON.stringify(delta.commitPathAudit) !== JSON.stringify(manifest.commitPathAudit) ||
    JSON.stringify(delta.runtimeTree) !== JSON.stringify(manifest.runtimeTree)
  ) {
    throw new Error("Release delta no longer matches the manifest.");
  }
  const clawHubRoster = computeTargetClawHubRosterAudit(
    cwd,
    manifest.targetSha,
    policy.release.version,
  );
  if (
    clawHubRoster.manifestSha256 !== manifest.clawHubAudit.manifestSha256 ||
    JSON.stringify(clawHubRoster.packages) !== JSON.stringify(manifest.clawHubAudit.packages)
  ) {
    throw new Error("Release target ClawHub roster no longer matches the manifest.");
  }
  const trust = computeTrustBundle(cwd, policy, manifest.producer.workflowSha);
  if (JSON.stringify(trust) !== JSON.stringify(manifest.trustBundle)) {
    throw new Error("Release delta trust bundle no longer matches.");
  }
  const changelog = git(cwd, ["show", `${manifest.targetSha}:CHANGELOG.md`], "buffer");
  const checks = Object.fromEntries(manifest.freshChecks.map((entry) => [entry.id, entry]));
  const releaseNotes = renderGithubReleaseNotes({
    changelog: changelog.toString("utf8"),
    version: manifest.version.replace(/-beta\.\d+$/u, ""),
    tag: manifest.releaseTag,
    repository: options.repo,
  }).body;
  if (
    sha256(changelog) !== checks.changelog.sha256 ||
    sha256(releaseNotes) !== checks["release-notes"].sha256
  ) {
    throw new Error("Release changelog or release notes no longer match.");
  }
  const [commit, ref, tag] = await Promise.all([
    api(`repos/${options.repo}/commits/${manifest.targetSha}`),
    api(`repos/${options.repo}/git/ref/heads/${manifest.targetRef}`),
    resolveRemoteTagState(manifest.releaseTag, manifest.targetSha, {
      repo: options.repo,
      api,
      apiOptional,
    }),
  ]);
  if (
    commit.sha !== manifest.targetSha ||
    commit.commit?.verification?.verified !== true ||
    ref.object?.sha !== manifest.targetSha ||
    tag.state !== "exact"
  ) {
    throw new Error("Target signature, release ref, or live tag peel differs.");
  }
  await verifyPromotablePackage(manifest, options, api, readers);
  return resultFor(manifest, manifestPath, {
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    manifestSha256: sha256(raw),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseReleaseDeltaArgs([...argv]);
  const result =
    options.command === "create"
      ? await createReleaseDelta(options)
      : await verifyReleaseDelta(options);
  writeOutputs(options.githubOutput, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
