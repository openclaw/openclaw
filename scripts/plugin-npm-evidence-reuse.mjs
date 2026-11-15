import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import { createReleaseEvidenceReplay, MAX_REPLAY_BYTES } from "./lib/release-evidence-replay.mjs";

const NPM_EVIDENCE_FILE = "plugin-npm-evidence.json";
const WORKFLOW = ".github/workflows/plugin-npm-release.yml";

export function npmEvidenceBinding(params, env = process.env) {
  const binding = {
    repository: params.repository,
    sourceSha: params.sourceSha,
    verifierSha: params.workflowSha,
    verifierRef: params.workflowFullRef,
    frvRunId: String(params.fullReleaseValidationRunId),
    frvRunAttempt: Number(params.fullReleaseValidationRunAttempt),
    parentRunId: env.PREPARED_NPM_PARENT_RUN_ID,
    parentRunAttempt: Number(env.PREPARED_NPM_PARENT_RUN_ATTEMPT),
    childRunId: env.GITHUB_RUN_ID,
    childRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    artifact: params.artifact,
    selectionMode: params.selectionMode,
    plugins: params.plugins
      .split(/[,\s]+/u)
      .filter(Boolean)
      .toSorted(),
    npmDistTag: params.npmDistTag,
  };
  if (
    ![binding.frvRunId, binding.parentRunId, binding.childRunId].every((id) =>
      /^[1-9][0-9]*$/u.test(id ?? ""),
    ) ||
    ![binding.frvRunAttempt, binding.parentRunAttempt, binding.childRunAttempt].every(
      (attempt) => Number.isSafeInteger(attempt) && attempt > 0,
    )
  ) {
    throw new Error("Evidence handoff requires exact FRV, publication parent and child attempts");
  }
  return binding;
}

export function npmEvidenceArtifactName(binding) {
  return "plugin-npm-evidence-" + binding.childRunId + "-" + binding.childRunAttempt;
}

export async function loadNpmEvidenceReplay({
  binding,
  artifactId,
  artifactDigest,
  token,
  archivePath,
  client,
  fetchImpl,
  shareAcquisitionReads = false,
}) {
  const current = await client.getRun(binding.childRunId);
  if (
    String(current.id) !== binding.childRunId ||
    current.run_attempt !== binding.childRunAttempt ||
    current.head_sha !== binding.verifierSha ||
    current.repository?.full_name !== binding.repository ||
    current.head_repository?.full_name !== binding.repository ||
    current.path !== WORKFLOW ||
    current.event !== "workflow_dispatch" ||
    "refs/" +
      (binding.verifierRef.startsWith("refs/tags/") ? "tags/" : "heads/") +
      current.head_branch !==
      binding.verifierRef
  ) {
    throw new Error("Evidence handoff producer is not this current trusted publication attempt");
  }
  const metadata = await client.getArtifact(artifactId);
  if (
    metadata.digest !== "sha256:" + artifactDigest ||
    !(Date.parse(metadata.expires_at) > Date.now())
  ) {
    throw new Error("Evidence handoff digest or expiry changed");
  }
  const downloaded = await downloadActionsArtifactArchive({
    token,
    fetchImpl,
    archivePath,
    maxArchiveBytes: MAX_REPLAY_BYTES,
    expected: {
      repository: binding.repository,
      runId: Number(binding.childRunId),
      runAttempt: binding.childRunAttempt,
      consumerRunAttempt: binding.childRunAttempt,
      workflowSha: binding.verifierSha,
      workflowPath: WORKFLOW,
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: current.head_branch,
      artifactId: Number(artifactId),
      artifactName: npmEvidenceArtifactName(binding),
      artifactDigest: "sha256:" + artifactDigest,
      artifactSizeBytes: metadata.size_in_bytes,
      artifactExpiresAt: metadata.expires_at,
      runStatePolicy: "same-run-producer-success",
      producerJobName: "preview_plugins_npm",
    },
  });
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, {
    expectedEntries: [NPM_EVIDENCE_FILE],
    maxArchiveBytes: MAX_REPLAY_BYTES,
    maxEntryBytes: () => MAX_REPLAY_BYTES,
    maxExpandedBytes: MAX_REPLAY_BYTES,
  });
  const payload = JSON.parse(files.get(NPM_EVIDENCE_FILE).toString("utf8"));
  const replay = createReleaseEvidenceReplay(binding, payload, { shareAcquisitionReads });
  replay.observeRun("actions/runs/" + binding.childRunId, current);
  replay.observeArchive(artifactId, metadata);
  // Reuse on disk is content-only: every invocation still authenticates metadata,
  // current attempt and the successful trusted preview job above.
  // The successful exact trusted preview, not a caller-created replay object,
  // authenticates this owner-produced graph projection.
  return Object.assign(replay, { authenticatedPreparedEvidence: payload.preparedEvidence });
}
