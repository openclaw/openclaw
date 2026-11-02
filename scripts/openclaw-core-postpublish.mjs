#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const PUBLISH_JOB = "Publish plugins, then OpenClaw";
const EVIDENCE_STEP = "Upload postpublish evidence";
const EVIDENCE_FILE = "release-postpublish-evidence.json";
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateOpenClawCorePostpublishEvidence(evidence, expected) {
  requireValue(isRecord(evidence), "Core npm postpublish evidence is invalid.");
  requireValue(
    evidence.version === 1 &&
      evidence.releaseVersion === expected.releaseTag.slice(1) &&
      evidence.releaseTag === expected.releaseTag &&
      evidence.npmDistTag === expected.npmDistTag &&
      evidence.releasePublishRunId === String(expected.parentRunId) &&
      evidence.npmRegistrySignaturesVerified === true &&
      evidence.npmProvenanceAttestationMatched === true &&
      typeof evidence.openclawNpmIntegrity === "string" &&
      evidence.openclawNpmIntegrity.length > 0 &&
      typeof evidence.openclawNpmTarball === "string" &&
      evidence.openclawNpmTarball.length > 0,
    "Core npm postpublish evidence differs from the failed publisher.",
  );
  return evidence;
}

export async function verifyOpenClawCorePostpublish({
  parent,
  artifact,
  releaseTag,
  npmDistTag,
  token,
  outputDir,
  fetchImpl = fetch,
}) {
  await mkdir(outputDir, { recursive: true });
  const downloaded = await downloadActionsArtifactArchive({
    token,
    fetchImpl,
    archivePath: join(outputDir, `${artifact.artifactId}.zip`),
    maxArchiveBytes: MAX_EVIDENCE_BYTES,
    expected: {
      ...artifact,
      runStatePolicy: "completed-producer-success",
      producerJobName: PUBLISH_JOB,
      producerStepName: EVIDENCE_STEP,
    },
  });
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, {
    expectedEntries: [EVIDENCE_FILE],
    maxArchiveBytes: MAX_EVIDENCE_BYTES,
    maxExpandedBytes: MAX_EVIDENCE_BYTES,
    maxEntryBytes: () => MAX_EVIDENCE_BYTES,
  });
  return validateOpenClawCorePostpublishEvidence(
    JSON.parse(files.get(EVIDENCE_FILE).toString("utf8")),
    { releaseTag, npmDistTag, parentRunId: parent.id },
  );
}
