import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  validateDockerReleaseManifest,
  verifyDockerReleaseProducer,
} from "../docker-release-artifacts.mjs";
import { verifyReleaseToolingIdentity } from "../release-tooling-identity.mjs";
import {
  inspectRaw,
  parsePlatform,
  verifyDockerAttestations,
} from "../verify-docker-attestations.mjs";
import {
  inspectActionsArtifactZip,
  inspectActionsArtifactZipWithPolicy,
} from "./actions-artifact-archive.mjs";
import { verifyNpmRegistrySignatures } from "./npm-registry-signatures.mjs";

const REPOSITORY = "openclaw/openclaw";
const PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const NPM_WORKFLOW = ".github/workflows/openclaw-npm-release.yml";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_JSON = 2 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`Stable publish recovery: ${message}`);
  }
}
function id(value) {
  requireValue(
    /^[1-9][0-9]*$/u.test(String(value)) && Number.isSafeInteger(Number(value)),
    "invalid run or attempt ID.",
  );
  return String(value);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function command(name, args, maxBuffer = 20 * 1024 * 1024) {
  return execFileSync(name, args, {
    encoding: "utf8",
    maxBuffer,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function api(endpoint) {
  return JSON.parse(command("gh", ["api", `repos/${REPOSITORY}/${endpoint}`], MAX_JSON));
}
function inventory(endpoint, key) {
  const result = [];
  for (let page = 1; page <= 10; page++) {
    const response = api(`${endpoint}?per_page=100&page=${page}`);
    requireValue(Array.isArray(response[key]), `missing ${key} inventory.`);
    result.push(...response[key]);
    if (result.length === response.total_count) {
      return result;
    }
    requireValue(
      result.length < response.total_count && response[key].length > 0,
      `incomplete ${key} inventory.`,
    );
  }
  throw new Error(`Stable publish recovery: ${key} inventory exceeds bound.`);
}
function one(values, label) {
  requireValue(values.length === 1, `${label} must be unique.`);
  return values[0];
}

export function validateRecoveryRun(run, expected) {
  for (const [key, value] of Object.entries({
    id: Number(id(expected.id)),
    run_attempt: Number(id(expected.attempt)),
    head_sha: expected.sha,
    path: expected.workflow,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: expected.conclusion,
  })) {
    const actual = key === "path" ? run?.path?.split("@")[0] : run?.[key];
    requireValue(actual === value, `run ${key} mismatch.`);
  }
  requireValue(
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
    "run repository mismatch.",
  );
  requireValue(SHA.test(run.head_sha), "invalid tooling SHA.");
  return run;
}

export function requireRecoveryJob(jobs, run, name) {
  const job = one(
    jobs.filter((entry) => entry.name === name),
    name,
  );
  requireValue(
    job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.head_sha === run.head_sha &&
      job.status === "completed" &&
      job.conclusion === "success",
    `${name} did not succeed in the exact attempt.`,
  );
  return job;
}

// This publisher’s historical Actions archives can contain only whole-job logs.
// These hashes bind exact canonical shell bodies, not arbitrary stdout patterns.
const HISTORICAL_PUBLISH_TOOLING = "01403169248346f2a6d6dd02955fc956fa9e1fe9";
const HISTORICAL_PUBLISH_STEPS = {
  Publish: {
    job: "publish_openclaw_npm",
    number: 20,
    sha256: "284d8130bb9335e54a825f0e93a4dee546ab8fcbdc54552873cd0b8c2b095275",
  },
  "Verify full release validation evidence": {
    job: "publish_openclaw_npm",
    number: 9,
    sha256: "231a75271a4d9dbdc3471be10352db212546f1aa0b6f0cb28409a079c18d6a35",
  },
  "Copy exact OCI digests, verify attestations, and promote aliases": {
    job: "Publish Docker images / Publish prepared Docker images",
    number: 17,
    sha256: "2282fdbc5e1ef4b4472208a3fac24bfd8a641484e012bee945d7d3cf3e6cebde",
  },
};
function historicalPublishStepLog(logs, job, step) {
  const contract = HISTORICAL_PUBLISH_STEPS[step.name];
  requireValue(
    job.head_sha === HISTORICAL_PUBLISH_TOOLING &&
      job.name === contract?.job &&
      contract?.number === step.number,
    "no historical runner-header contract for missing step log.",
  );
  const wholeJob = one(
    [...logs].filter(
      ([name]) =>
        /^[0-9]+_/u.test(name) &&
        name.slice(name.indexOf("_") + 1) === `${job.name.replaceAll("/", "_")}.txt`,
    ),
    "historical whole-job log",
  )[1];
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(wholeJob).split("\n");
  const groups = [];
  for (let index = 0; index < lines.length; index++) {
    const start = /^(\d{4}-\d\d-\d\dT\S+Z) ##\[group\]Run (.*)$/u.exec(lines[index]);
    if (!start) {
      continue;
    }
    const code = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor].replace(/^\S+ /u, "");
      if (!line.startsWith("\u001b[36;1m") || !line.endsWith("\u001b[0m")) {
        break;
      }
      code.push(line.slice("\u001b[36;1m".length, -"\u001b[0m".length));
      cursor++;
    }
    if (sha256(code.join("\n").trim()) !== contract.sha256) {
      continue;
    }
    requireValue(start[2] === code[0], "historical Run header differs from its frozen shell body.");
    requireValue(
      lines[cursor]?.replace(/^\S+ /u, "") === "shell: /usr/bin/bash -e {0}" &&
        lines[cursor + 1]?.replace(/^\S+ /u, "") === "env:",
      "historical runner shell/environment header mismatch.",
    );
    const end = lines.findIndex(
      (line, offset) => offset > cursor && line.replace(/^\S+ /u, "") === "##[endgroup]",
    );
    requireValue(
      end > cursor && !lines.slice(cursor + 2, end).some((line) => line.includes("##[group]")),
      "historical runner input group truncated.",
    );
    groups.push({
      timestamp: Date.parse(start[1]),
      bytes: Buffer.from(lines.slice(index, end + 1).join("\n")),
    });
  }
  const group = one(groups, "frozen historical runner header");
  const started = Date.parse(step.started_at);
  const completed = Date.parse(step.completed_at);
  requireValue(
    Number.isFinite(started) &&
      Number.isFinite(completed) &&
      started < completed &&
      group.timestamp >= started &&
      group.timestamp < completed,
    "historical header is outside the exact successful step window.",
  );
  return group.bytes;
}

// The exact attempt archive owns step names/numbers. Only the first runner
// input group of that successful step is evidence; its stdout is not.
export function readRecoveryStepInputs(log, job, stepName) {
  const step = one(
    job.steps.filter((entry) => entry.name === stepName),
    stepName,
  );
  requireValue(
    step.status === "completed" && step.conclusion === "success",
    `${stepName} did not succeed.`,
  );
  const filename = `${job.name.replaceAll("/", "_")}/${step.number}_${stepName.replaceAll("/", "_")}.txt`;
  const bytes = log.get(filename) ?? historicalPublishStepLog(log, job, step);
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split("\n")
    .map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\S+Z /u, ""));
  requireValue(lines[0]?.startsWith("##[group]Run "), `${stepName} runner input group missing.`);
  const end = lines.indexOf("##[endgroup]");
  requireValue(end > 0, `${stepName} runner input group incomplete.`);
  const header = lines.slice(1, end);
  requireValue(
    header.filter((line) => line === "env:").length === 1,
    `${stepName} environment must be unique.`,
  );
  const env = {};
  for (const line of header.slice(header.indexOf("env:") + 1)) {
    const match = /^ {2}([A-Z][A-Z0-9_]*): (.*)$/u.exec(line);
    requireValue(
      match && !Object.hasOwn(env, match[1]),
      `${stepName} malformed or duplicate environment field.`,
    );
    env[match[1]] = match[2];
  }
  return env;
}
function expectInputs(inputs, expected) {
  for (const [key, value] of Object.entries(expected)) {
    requireValue(inputs[key] === String(value), `step input ${key} mismatch.`);
  }
}
function attemptLogs(run) {
  const bytes = execFileSync(
    "gh",
    ["api", `repos/${REPOSITORY}/actions/runs/${id(run.id)}/attempts/${id(run.run_attempt)}/logs`],
    { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
  );
  return inspectActionsArtifactZipWithPolicy(bytes, {
    minEntries: 1,
    maxEntries: 1024,
    maxArchiveBytes: 32 * 1024 * 1024,
    maxExpandedBytes: 128 * 1024 * 1024,
    allowPath: (name) => name.endsWith(".txt"),
    maxCompressedEntryBytes: () => 20 * 1024 * 1024,
    maxEntryBytes: () => 20 * 1024 * 1024,
  });
}

function artifactJson(run, name, file, expectedDigest) {
  const artifact = one(
    inventory(`actions/runs/${id(run.id)}/artifacts`, "artifacts").filter(
      (entry) => entry.name === name,
    ),
    name,
  );
  requireValue(
    !artifact.expired &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run?.head_sha === run.head_sha &&
      artifact.workflow_run?.head_branch === run.head_branch &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
    "artifact producer mismatch.",
  );
  requireValue(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= MAX_JSON,
    "artifact size exceeds bound.",
  );
  const bytes = execFileSync(
    "gh",
    ["api", `repos/${REPOSITORY}/actions/artifacts/${id(artifact.id)}/zip`],
    { maxBuffer: MAX_JSON, timeout: 120_000 },
  );
  requireValue(
    bytes.length === artifact.size_in_bytes && `sha256:${sha256(bytes)}` === artifact.digest,
    "artifact archive digest mismatch.",
  );
  const files = inspectActionsArtifactZip(bytes, [file], {
    maxEntryBytes: MAX_JSON,
    maxExpandedBytes: MAX_JSON,
  });
  const payload = files.get(file);
  requireValue(
    !expectedDigest || sha256(payload) === expectedDigest,
    "qualified manifest digest mismatch.",
  );
  const reread = api(`actions/artifacts/${id(artifact.id)}`);
  requireValue(
    reread.digest === artifact.digest && reread.id === artifact.id && !reread.expired,
    "artifact changed during verification.",
  );
  return {
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
    artifact: { id: String(artifact.id), digest: artifact.digest, name },
  };
}
function dispatch(run, sourceSha) {
  const record = artifactJson(
    run,
    `openclaw-release-children-${run.id}-${run.run_attempt}`,
    "dispatch.json",
  );
  const value = record.value;
  requireValue(
    value.schemaVersion === 1 &&
      value.repository === REPOSITORY &&
      value.parentWorkflow === PUBLISH_WORKFLOW &&
      value.parentRunId === id(run.id) &&
      value.parentRunAttempt === id(run.run_attempt) &&
      value.toolingSha === run.head_sha &&
      value.toolingRef === run.head_branch &&
      value.candidateSha === sourceSha,
    "dispatch identity mismatch.",
  );
  requireValue(
    new RegExp(`^refs/tags/release-publish/${run.head_sha.slice(0, 12)}-[1-9][0-9]*$`, "u").test(
      value.toolingFullRef,
    ) && value.toolingFullRef === `refs/tags/${value.toolingRef}`,
    "dispatch must bind protected publisher tooling.",
  );
  verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: value.toolingRef,
    workflowFullRef: value.toolingFullRef,
    workflowSha: value.toolingSha,
  });
  return record;
}

async function registryBytes(url, maxBytes) {
  requireValue(
    typeof url === "string" && url.startsWith("https://registry.npmjs.org/"),
    "untrusted npm URL.",
  );
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  requireValue(response.ok && response.body, "npm registry request failed.");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    requireValue(length <= maxBytes, "npm registry response exceeds bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function validateRecoveryProvenance(results, expected) {
  const statements = results
    .map((result) => result.verificationResult?.statement)
    .filter((statement) => statement?.predicateType === "https://slsa.dev/provenance/v1");
  const statement = one(statements, "verified npm provenance");
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  requireValue(
    workflow?.repository === `https://github.com/${REPOSITORY}` &&
      workflow.path === NPM_WORKFLOW &&
      workflow.ref === expected.fullRef,
    "verified npm workflow mismatch.",
  );
  requireValue(
    statement.predicate?.runDetails?.metadata?.invocationId ===
      `https://github.com/${REPOSITORY}/actions/runs/${expected.runId}/attempts/${expected.attempt}`,
    "verified npm invocation mismatch.",
  );
  requireValue(
    statement.subject?.some(
      (subject) =>
        subject.name ===
          `pkg:npm/${expected.name.split("/").map(encodeURIComponent).join("/")}@${expected.version}` &&
        subject.digest?.sha512 === expected.sha512,
    ),
    "verified npm subject mismatch.",
  );
}
async function verifyNpm(evidence, manifest, run, fullRef, directory) {
  const bundle = manifest.publicationArtifacts?.npmPreflight?.preparedBundle;
  requireValue(
    bundle?.source?.sha === manifest.targetSha &&
      bundle.package?.sourceSha === manifest.targetSha &&
      bundle.package?.name === "openclaw",
    "qualified npm source missing.",
  );
  const packages = [
    { name: bundle.package.name, version: bundle.package.version, digest: bundle.package.sha256 },
    ...(bundle.corePackages ?? []).map((entry) => ({
      name: entry.packageName,
      version: entry.packageVersion,
      digest: entry.tarballSha256,
    })),
  ];
  requireValue(
    packages.length <= 16 && new Set(packages.map((entry) => entry.name)).size === packages.length,
    "invalid qualified core package set.",
  );
  const registryKeys = JSON.parse(
    await registryBytes("https://registry.npmjs.org/-/npm/v1/keys", MAX_JSON),
  );
  requireValue(Array.isArray(registryKeys.keys), "npm registry signing keys missing.");
  const receipts = [];
  for (const [index, pkg] of packages.entries()) {
    requireValue(
      pkg.version === evidence.releaseVersion &&
        DIGEST.test(pkg.digest) &&
        /^(?:@openclaw\/)?[a-z0-9-]+$/u.test(pkg.name),
      "invalid qualified package identity.",
    );
    const document = JSON.parse(
      await registryBytes(
        `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
        MAX_JSON,
      ),
    );
    const { integrity, tarball, attestations, signatures } = document.dist ?? {};
    requireValue(
      document.name === pkg.name &&
        document.version === pkg.version &&
        /^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity),
      "registry package identity mismatch.",
    );
    requireValue(Array.isArray(signatures), "npm registry signatures missing.");
    verifyNpmRegistrySignatures({
      packageName: pkg.name,
      version: pkg.version,
      integrity,
      signatures,
      keys: registryKeys.keys,
    });
    if (pkg.name === "openclaw") {
      requireValue(
        integrity === evidence.openclawNpmIntegrity && tarball === evidence.openclawNpmTarball,
        "npm postpublish integrity mismatch.",
      );
    }
    const bytes = await registryBytes(tarball, 256 * 1024 * 1024);
    requireValue(
      sha256(bytes) === pkg.digest &&
        `sha512-${createHash("sha512").update(bytes).digest("base64")}` === integrity,
      "qualified npm bytes mismatch.",
    );
    const attestationsJson = JSON.parse(await registryBytes(attestations?.url, MAX_JSON));
    const provenance = one(
      (attestationsJson.attestations ?? []).filter(
        (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
      ),
      "npm provenance bundle",
    );
    const tarballPath = join(directory, `${index}.tgz`);
    const bundlePath = join(directory, `${index}.json`);
    writeFileSync(tarballPath, bytes);
    writeFileSync(bundlePath, JSON.stringify(provenance.bundle));
    const verified = JSON.parse(
      command("gh", [
        "attestation",
        "verify",
        tarballPath,
        "--repo",
        REPOSITORY,
        "--bundle",
        bundlePath,
        "--digest-alg",
        "sha512",
        "--cert-identity",
        `https://github.com/${REPOSITORY}/${NPM_WORKFLOW}@${fullRef}`,
        "--source-digest",
        run.head_sha,
        "--format",
        "json",
      ]),
    );
    validateRecoveryProvenance(verified, {
      ...pkg,
      fullRef,
      runId: id(run.id),
      attempt: id(run.run_attempt),
      sha512: Buffer.from(integrity.slice(7), "base64").toString("hex"),
    });
    receipts.push({
      name: pkg.name,
      version: pkg.version,
      sha256: pkg.digest,
      integrity,
      registrySignaturesVerified: true,
      sigstoreProvenanceVerified: true,
    });
  }
  return receipts;
}

function verifyRecoveryDockerIndexes(manifest) {
  const results = [];
  for (const registry of ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"]) {
    for (const variant of manifest.includeBrowser ? ["default", "browser"] : ["default"]) {
      const images = manifest.architectures.flatMap((entry) =>
        entry.images.filter((image) => image.variant === variant),
      );
      const descriptors = images
        .flatMap((image) => image.manifests)
        .toSorted((a, b) => a.digest.localeCompare(b.digest));
      for (const suffix of variant === "default" ? ["", "-slim"] : ["-browser"]) {
        const ref = `${registry}:${manifest.version}${suffix}`;
        const digest = JSON.parse(
          command("docker", [
            "buildx",
            "imagetools",
            "inspect",
            ref,
            "--format",
            "{{json .Manifest}}",
          ]),
        ).digest;
        requireValue(/^sha256:[a-f0-9]{64}$/u.test(digest), "invalid published Docker digest.");
        const pinned = `${registry}@${digest}`;
        const raw = inspectRaw(pinned);
        requireValue(
          isDeepStrictEqual(
            JSON.parse(raw).manifests?.toSorted((a, b) => a.digest.localeCompare(b.digest)),
            descriptors,
          ),
          "published Docker image or attestation descriptors differ from qualified bytes.",
        );
        verifyDockerAttestations({
          imageRefs: [pinned],
          requiredPlatforms: [parsePlatform("linux/amd64"), parsePlatform("linux/arm64")],
          log() {},
        });
        results.push({ ref, digest });
      }
    }
  }
  return results;
}

export async function verifyStablePublishRecovery({ evidence, manifest, sourceSha, tag }) {
  requireValue(
    evidence.releaseTag === tag &&
      evidence.releaseTag === `v${evidence.releaseVersion}` &&
      evidence.releaseSha === sourceSha &&
      manifest.targetSha === sourceSha &&
      SHA.test(sourceSha),
    "release source mismatch.",
  );
  const originalId = id(evidence.releasePublishRunId);
  const npmId = id(evidence.operatorRecovery?.npmPublishRunId);
  const dockerId = id(evidence.operatorRecovery?.dockerPromotionRunId);
  requireValue(
    originalId !== dockerId && originalId !== npmId && dockerId !== npmId,
    "split recovery requires distinct runs.",
  );
  requireValue(
    one(
      evidence.workflowRuns.filter((entry) => entry.label === "OpenClaw NPM Release"),
      "npm evidence",
    ).id === npmId,
    "npm evidence run mismatch.",
  );
  const npmLatest = api(`actions/runs/${npmId}`);
  const npm = validateRecoveryRun(
    api(`actions/runs/${npmId}/attempts/${id(npmLatest.run_attempt)}`),
    {
      id: npmId,
      attempt: npmLatest.run_attempt,
      sha: npmLatest.head_sha,
      workflow: NPM_WORKFLOW,
      conclusion: "success",
    },
  );
  const npmJob = requireRecoveryJob(
    inventory(`actions/runs/${npmId}/attempts/${npm.run_attempt}/jobs`, "jobs"),
    npm,
    "publish_openclaw_npm",
  );
  const npmLog = attemptLogs(npm);
  const npmInputs = readRecoveryStepInputs(npmLog, npmJob, "Publish");
  const originalAttempt = id(npmInputs.RELEASE_PUBLISH_RUN_ATTEMPT);
  expectInputs(npmInputs, { RELEASE_PUBLISH_RUN_ID: originalId, WORKFLOW_SHA: npm.head_sha });
  const original = validateRecoveryRun(
    api(`actions/runs/${originalId}/attempts/${originalAttempt}`),
    {
      id: originalId,
      attempt: originalAttempt,
      sha: npm.head_sha,
      workflow: PUBLISH_WORKFLOW,
      conclusion: "failure",
    },
  );
  const originalDispatch = dispatch(original, sourceSha);
  expectInputs(npmInputs, {
    RELEASE_PUBLISH_FULL_REF: originalDispatch.value.toolingFullRef,
    WORKFLOW_FULL_REF: originalDispatch.value.toolingFullRef,
  });
  requireValue(npm.head_branch === original.head_branch, "npm tooling ref mismatch.");
  const validationInputs = {
    FULL_RELEASE_VALIDATION_RUN_ID: id(manifest.runId),
    FULL_RELEASE_VALIDATION_RUN_ATTEMPT: id(manifest.runAttempt),
    RELEASE_TAG: evidence.releaseTag,
  };
  expectInputs(
    readRecoveryStepInputs(npmLog, npmJob, "Verify full release validation evidence"),
    validationInputs,
  );
  const dockerLatest = api(`actions/runs/${dockerId}`);
  const docker = validateRecoveryRun(
    api(`actions/runs/${dockerId}/attempts/${id(dockerLatest.run_attempt)}`),
    {
      id: dockerId,
      attempt: dockerLatest.run_attempt,
      sha: npm.head_sha,
      workflow: PUBLISH_WORKFLOW,
      conclusion: "success",
    },
  );
  const dockerDispatch = dispatch(docker, sourceSha);
  requireValue(
    dockerDispatch.value.toolingFullRef === originalDispatch.value.toolingFullRef,
    "Docker publisher tooling ref mismatch.",
  );
  const dockerJobs = inventory(
    `actions/runs/${dockerId}/attempts/${docker.run_attempt}/jobs`,
    "jobs",
  );
  const dockerJob = requireRecoveryJob(
    dockerJobs,
    docker,
    "Publish Docker images / Publish prepared Docker images",
  );
  const dockerLogs = attemptLogs(docker);
  // The successful promotion consumed exactly the OCI tuple qualified by this
  // FRV; no whole-job resolver output is needed to reconstruct its inputs.
  const prepared = manifest.publicationArtifacts?.docker;
  requireValue(
    prepared && DIGEST.test(prepared.preparedManifestSha256),
    "qualified Docker manifest missing.",
  );
  expectInputs(
    readRecoveryStepInputs(
      dockerLogs,
      dockerJob,
      "Copy exact OCI digests, verify attestations, and promote aliases",
    ),
    {
      RELEASE_TAG: evidence.releaseTag,
      RELEASE_SHA: sourceSha,
      PREPARED_RUN_ID: id(prepared.preparedRunId),
      PREPARED_RUN_ATTEMPT: id(prepared.preparedRunAttempt),
      PREPARED_ARTIFACT_NAME: prepared.preparedArtifactName,
      PREPARED_MANIFEST_SHA256: prepared.preparedManifestSha256,
    },
  );
  const producer = api(
    `actions/runs/${id(prepared.preparedRunId)}/attempts/${id(prepared.preparedRunAttempt)}`,
  );
  const dockerArtifact = artifactJson(
    producer,
    prepared.preparedArtifactName,
    "manifest.json",
    prepared.preparedManifestSha256,
  );
  validateDockerReleaseManifest(dockerArtifact.value, {
    repository: REPOSITORY,
    tag: evidence.releaseTag,
    sourceSha,
    runId: prepared.preparedRunId,
    runAttempt: prepared.preparedRunAttempt,
    artifactName: prepared.preparedArtifactName,
  });
  verifyDockerReleaseProducer(dockerArtifact.value, { publisherSha: docker.head_sha });
  const directory = mkdtempSync(join(tmpdir(), "openclaw-stable-recovery-"));
  try {
    const npmPackages = await verifyNpm(
      evidence,
      manifest,
      npm,
      originalDispatch.value.toolingFullRef,
      directory,
    );
    const dockerImages = verifyRecoveryDockerIndexes(dockerArtifact.value);
    // Reruns cannot silently replace the publication attempts just verified.
    for (const run of [npm, docker]) {
      const current = api(`actions/runs/${run.id}`);
      validateRecoveryRun(current, {
        id: run.id,
        attempt: run.run_attempt,
        sha: run.head_sha,
        workflow: run.path.split("@")[0],
        conclusion: "success",
      });
    }
    return {
      npmDockerVerified: true,
      mode: "split-publication-v1",
      releaseTag: tag,
      sourceSha,
      toolingSha: npm.head_sha,
      fullReleaseValidation: { runId: id(manifest.runId), runAttempt: id(manifest.runAttempt) },
      originalParent: {
        runId: originalId,
        runAttempt: originalAttempt,
        conclusion: "failure",
        dispatchArtifact: originalDispatch.artifact,
      },
      npm: {
        runId: npmId,
        runAttempt: id(npm.run_attempt),
        jobId: id(npmJob.id),
        packages: npmPackages,
      },
      docker: {
        runId: dockerId,
        runAttempt: id(docker.run_attempt),
        jobId: id(dockerJob.id),
        dispatchArtifact: dockerDispatch.artifact,
        preparedArtifact: dockerArtifact.artifact,
        preparedManifestSha256: prepared.preparedManifestSha256,
        images: dockerImages,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
