import { validateReleaseExecutionPlanArtifact } from "../full-release-validation-policy.mjs";
import {
  buildReleaseValidationManifest,
  manifestContextFromEnvironment,
} from "./full-release-manifest.mjs";

// Dallin Romney, 2026-11-19 12:10 UTC: waive qualification for this exact
// version/candidate, including failed, cancelled and unfinished coverage.
// This is not a passing verdict. Artifact integrity and publisher authority stay mandatory.
export const FRV18_PUBLICATION_EXCEPTION = Object.freeze({
  kind: "exact-version-qualification-exception",
  parentRunId: "44507108002",
  parentRunAttempt: 1,
  candidateSha: "995f9059b6e6fe3ba0865a3354924fd2bcbfceea",
  version: "2026.11.10-beta.1",
  planArtifactId: "14524452145",
  planArtifactDigest: "sha256:e6cd16c92abefdc5f4a4aa949c1c8b369ec89a708652e45181d8a49cd8eea5ae",
});

export function isFrv18Parent(run, repository) {
  return (
    repository === "openclaw/openclaw" && run.head_sha === FRV18_PUBLICATION_EXCEPTION.candidateSha
  );
}

export function isFrv18PublicationManifest(manifest) {
  return (
    manifest.targetSha === FRV18_PUBLICATION_EXCEPTION.candidateSha &&
    manifest.validationInputs?.targetVersion === FRV18_PUBLICATION_EXCEPTION.version
  );
}

export function isFrv18PublicationException(evidence) {
  return (
    evidence.valid === true &&
    evidence.repository === "openclaw/openclaw" &&
    evidence.directRoot === true &&
    evidence.evidenceReuse === null &&
    isFrv18PublicationManifest(evidence.current?.manifest ?? {}) &&
    evidence.current?.publicationException?.disposition === "qualification-waived"
  );
}

export function validateFrv18Plan(plan, artifact) {
  const grant = FRV18_PUBLICATION_EXCEPTION;
  if (
    String(artifact.id) !== grant.planArtifactId ||
    artifact.digest !== grant.planArtifactDigest ||
    artifact.name !== "full-release-execution-plan-" + grant.parentRunId ||
    plan.parentRunId !== grant.parentRunId ||
    plan.parentRunAttempt !== 1 ||
    plan.targetSha !== grant.candidateSha ||
    plan.workflowSha !== grant.candidateSha ||
    plan.targetVersion !== grant.version ||
    plan.releaseProfile !== "beta" ||
    plan.coveragePolicy !== "npm-beta-v1" ||
    plan.rerunGroup !== "all" ||
    plan.evidenceReuse.requested
  ) {
    throw new Error("FRV18 publication exception differs from its exact beta plan");
  }
  return validateReleaseExecutionPlanArtifact(plan, {
    parentRunId: grant.parentRunId,
    repository: "openclaw/openclaw",
    targetSha: grant.candidateSha,
    workflowSha: grant.candidateSha,
    releaseProfile: "beta",
    rerunGroup: "all",
  });
}

export async function projectFrv18Publication(plan, client) {
  const grant = FRV18_PUBLICATION_EXCEPTION;
  // These are original, immutable producer receipts, not newly uploaded manifests.
  const [npm, docker, plugin] = await Promise.all([
    client.loadPinnedJsonArtifact({
      runId: "44507905054",
      id: "14524072184",
      digest: "sha256:2a23066c1cdfe86e34ebd5c87764d517fdefa64eedd76c6e13d6cbd1eeecef76",
      name: "full-release-artifact-receipt-44507905054-1",
      entry: "artifact-receipt.json",
    }),
    client.loadPinnedJsonArtifact({
      runId: "44507904089",
      id: "14522220831",
      digest: "sha256:1a734af8170eec198d551c1dcda0df6d7c05bd7e163fe2f105269284e57ade77",
      name: "full-release-artifact-receipt-44507904089-1",
      entry: "artifact-receipt.json",
    }),
    client.loadPinnedJsonArtifact({
      runId: "44507913588",
      id: "14519599717",
      digest: "sha256:313299faf216bdcfd02fd9bb1dc6c52babb26b07cd2d30427d8cd53c53786d08",
      name: "plugin-npm-prepared-" + grant.candidateSha + "-44507913588-1",
      entry: "plugin-npm-prepared.json",
    }),
  ]);
  for (const [stage, receipt] of [
    ["npm", npm],
    ["docker", docker],
  ]) {
    if (
      receipt.schema !== "openclaw.full-release-artifact-receipt/v1" ||
      receipt.stage !== stage ||
      receipt.dispatchId !== "full-release-validation-44507108002-1-artifacts-" + stage ||
      receipt.repository !== "openclaw/openclaw" ||
      receipt.sourceSha !== grant.candidateSha ||
      receipt.toolingSha !== grant.candidateSha ||
      receipt.workflowRef !== plan.workflowRef ||
      receipt.releaseTag !== "v" + grant.version ||
      receipt.runAttempt !== "1"
    ) {
      throw new Error("FRV18 original publication receipt identity mismatch");
    }
    const run = await client.getRun(receipt.runId);
    if (
      String(run.id) !== receipt.runId ||
      run.run_attempt !== 1 ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.head_sha !== grant.candidateSha ||
      run.head_branch !== plan.workflowRef ||
      String(run.path).split("@", 1)[0] !== ".github/workflows/full-release-artifacts.yml" ||
      run.display_title !== "Full Release Artifacts " + receipt.dispatchId
    ) {
      throw new Error("FRV18 original publication producer did not succeed");
    }
  }
  const context = manifestContextFromEnvironment(plan.sourceAdmission, {
    GITHUB_RUN_ID: grant.parentRunId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF_NAME: plan.workflowRef,
    GITHUB_SHA: grant.candidateSha,
    GITHUB_REF: "refs/heads/" + plan.workflowRef,
    GITHUB_REF_TYPE: "branch",
    TARGET_REF: grant.candidateSha,
    RELEASE_PROFILE: "beta",
    RERUN_GROUP: "all",
    RUN_RELEASE_SOAK: "false",
    QUALIFIED_NPM_BUNDLE_JSON: npm.outputs.qualified_preflight_bundle_json,
    PREPARED_PLUGIN_NPM_JSON: JSON.stringify({
      ...plugin.producer,
      artifactName: "plugin-npm-prepared-" + grant.candidateSha + "-44507913588-1",
      artifactId: 14519599717,
      artifactDigest: "sha256:313299faf216bdcfd02fd9bb1dc6c52babb26b07cd2d30427d8cd53c53786d08",
      artifactSizeBytes: 9125,
      repository: "openclaw/openclaw",
      workflowSha: grant.candidateSha,
    }),
    PREPARED_DOCKER_RUN_ID: docker.outputs.prepared_run_id,
    PREPARED_DOCKER_RUN_ATTEMPT: docker.outputs.prepared_run_attempt,
    PREPARED_DOCKER_ARTIFACT_NAME: docker.outputs.prepared_artifact_name,
    PREPARED_DOCKER_MANIFEST_SHA256: docker.outputs.prepared_manifest_sha256,
  });
  const manifest = buildReleaseValidationManifest({ plan, context });
  manifest.publishInputs = await client.loadPlanPublishInputs(manifest);
  return { manifest };
}
