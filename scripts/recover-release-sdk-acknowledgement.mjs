#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import {
  isPluginSdkApiAcknowledgement,
  selectPluginSdkApiReleaseEvidence,
} from "./plugin-sdk-api-release-evidence.mjs";
import {
  runReleaseToolingGh,
  validateReleasePublishParentRun,
  verifyReleaseToolingIdentity,
} from "./release-tooling-identity.mjs";

const repository = "openclaw/openclaw";
const workflow = ".github/workflows/openclaw-release-publish.yml";
const filename = "review.json";
const maxBytes = 8192;

async function recoverReleaseSdkAcknowledgement(env, manifest) {
  const selector = /^reuse:([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(env.SDK_ACKNOWLEDGEMENT_REUSE);
  if (!selector || env.GITHUB_REPOSITORY !== repository) {
    throw new Error("SDK acknowledgement reuse requires a canonical prior publisher run/attempt.");
  }
  const [, runId, attempt] = selector;
  const api = (endpoint) =>
    JSON.parse(runReleaseToolingGh(["api", `repos/${repository}/${endpoint}`, "--method", "GET"]));
  const run = api(`actions/runs/${runId}/attempts/${attempt}`);
  if (run.status !== "completed" || !run.head_branch?.startsWith("release-publish/")) {
    throw new Error("SDK acknowledgement reuse requires a completed protected publisher run.");
  }
  const fullRef = `refs/tags/${run.head_branch}`;
  const identity = verifyReleaseToolingIdentity({
    repository,
    workflowRef: run.head_branch,
    workflowFullRef: fullRef,
    workflowSha: run.head_sha,
  });
  validateReleasePublishParentRun({
    identity,
    releasePublishFullRef: fullRef,
    releasePublishParentStatePolicy: "manual-recovery",
    releasePublishRef: identity.ref,
    releasePublishRunId: runId,
    releasePublishRunAttempt: attempt,
    repository,
    run,
  });

  const artifactName = `release-sdk-acknowledgement-${runId}-${attempt}`;
  const listing = api(`actions/runs/${runId}/artifacts?name=${artifactName}&per_page=100`);
  const [artifact] = listing.artifacts ?? [];
  if (listing.total_count !== 1 || listing.artifacts?.length !== 1 || artifact?.expired !== false) {
    throw new Error("Prior SDK acknowledgement record is missing, expired, or ambiguous.");
  }
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    expected: {
      repository,
      artifactId: artifact.id,
      artifactName,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: Number(runId),
      workflowSha: identity.sha,
    },
    token: env.GH_TOKEN,
    maxArchiveBytes: maxBytes,
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [filename],
    maxArchiveBytes: maxBytes,
    maxExpandedBytes: maxBytes,
    maxEntryBytes: () => maxBytes,
  });
  const bytes = files.get(filename);
  const directory = mkdtempSync(join(tmpdir(), "release-sdk-review-"));
  try {
    const path = join(directory, filename);
    writeFileSync(path, bytes, { flag: "wx" });
    runReleaseToolingGh([
      "attestation",
      "verify",
      path,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/${workflow}`,
      "--signer-digest",
      identity.sha,
      "--source-digest",
      identity.sha,
      "--source-ref",
      fullRef,
      "--deny-self-hosted-runners",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const review = JSON.parse(bytes.toString("utf8"));
  const evidence = selectPluginSdkApiReleaseEvidence({
    evidence: manifest.pluginSdkApi,
    npmDistTag: env.RELEASE_NPM_DIST_TAG,
  });
  if (
    review?.runId !== runId ||
    review.attempt !== attempt ||
    review.releaseTag !== env.RELEASE_TAG ||
    review.targetSha !== env.EXPECTED_SHA ||
    review.npmDistTag !== env.RELEASE_NPM_DIST_TAG ||
    !/^[a-f0-9]{64}$/u.test(review.digest) ||
    review.digest !== evidence?.digest ||
    !isPluginSdkApiAcknowledgement(review.acknowledgement)
  ) {
    throw new Error("Prior SDK acknowledgement does not match this release and SDK evidence.");
  }
  // The caller still runs the normal validator, which recomputes the digest
  // and checks the recorded acknowledgement against the actual diff and selector.
  return review.acknowledgement;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
    process.stdout.write(await recoverReleaseSdkAcknowledgement(process.env, manifest));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "Review the SDK evidence and rerun Docker-only recovery with the explicit plugin_sdk_api_acknowledgement instead of reuse.",
    );
    process.exitCode = 1;
  }
}
