#!/usr/bin/env node
// Binds Full Release Validation run metadata to its supported evidence manifest.
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  normalizePublicationIntent,
  publicationObservationJson,
  publicationSourceJson,
} from "./full-release-publication-contract.mjs";
import { sortJsonValueKeys } from "./lib/canonical-json.mjs";
import { resolveReleaseContextIdentity } from "./lib/release-context.mjs";
import { verifyReceiptRecoveryAuthority } from "./lib/release-evidence-identity.mjs";
import { resolveReleasePublishInputs } from "./lib/release-publish-inputs.mjs";
import { createReleaseEvidenceClient, validateReleaseRunEvidence } from "./release-ci-summary.mjs";

const PINNED_BRANCH_PATTERN = /^release-ci\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
/** @param {unknown} value */
function scalarString(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

/**
 * @typedef {object} FullReleaseValidationManifest
 * @property {unknown} [version]
 * @property {unknown} [advisoryJobs]
 * @property {unknown} [childEvidence]
 * @property {unknown} [childRuns]
 * @property {unknown} [workflowName]
 * @property {unknown} [runId]
 * @property {unknown} [runAttempt]
 * @property {unknown} [workflowRef]
 * @property {unknown} [workflowSha]
 * @property {unknown} [workflowFullRef]
 * @property {unknown} [workflowRefType]
 * @property {unknown} [targetRef]
 * @property {unknown} [targetSha]
 * @property {unknown} [releaseProfile]
 * @property {unknown} [rerunGroup]
 * @property {unknown} [runReleaseSoak]
 * @property {unknown} [sourceAdmissionContract]
 * @property {unknown} [sourceAdmission]
 * @property {unknown} [publicationAdmissionContract]
 * @property {unknown} [publicationAdmission]
 * @property {unknown} [sourceParentRunAttempt]
 * @property {{ package?: { version?: unknown } }} [candidateBinding]
 * @property {{ coveragePolicy?: unknown, targetVersion?: unknown, targetContextRef?: unknown, knownFlakyJobsJson?: unknown }} [validationInputs]
 * @property {unknown} [qualificationCoverage]
 * @property {unknown} [receiptRecovery]
 * @property {{ changedPaths?: unknown, evidenceSha?: unknown, policy?: unknown, runId?: unknown, selectedRunId?: unknown }} [evidenceReuse]
 */
/**
 * @typedef {object} FullReleaseValidationEvidenceOptions
 * @property {unknown} run
 * @property {FullReleaseValidationManifest} manifest
 * @property {string} expectedRepository
 * @property {string | number} expectedRunId
 * @property {string | number} [expectedRunAttempt]
 * @property {string} expectedTargetSha
 * @property {string} [expectedReleaseTag]
 * @property {string} [expectedTrustedWorkflowFullRef]
 * @property {string} [expectedTrustedWorkflowSha]
 * @property {import("./full-release-publication-contract.mjs").PublicationSelection | (() => import("./full-release-publication-contract.mjs").PublicationSelection)} [expectedPublicationSelection]
 * @property {import("./full-release-publication-contract.mjs").PublicationSelection | (() => import("./full-release-publication-contract.mjs").PublicationSelection)} [expectedPublicationOperation]
 * @property {{ npmDistTag: string }} [expectedCoreNpmPublication]
 */

function normalizeFullReleaseValidationRun(run) {
  const [workflowPath, workflowQualifiedRef] = String(run.path ?? run.workflowPath ?? "").split(
    "@",
    2,
  );
  return {
    databaseId: String(run.id ?? run.databaseId ?? ""),
    runAttempt: Number(run.run_attempt ?? run.runAttempt ?? run.attempt),
    workflowName: run.name ?? run.workflowName,
    workflowPath,
    workflowQualifiedRef,
    repository: run.repository?.full_name ?? run.repository,
    headBranch: run.head_branch ?? run.headBranch,
    headSha: run.head_sha ?? run.headSha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url ?? run.url,
  };
}

export function isShaPinnedReleaseValidationBranch(branch) {
  return PINNED_BRANCH_PATTERN.test(branch ?? "");
}

/**
 * The caller has authenticated the complete original admission. This derives
 * only the current operation; it never rewrites the admission or artifact roster.
 * @param {import("./full-release-publication-contract.mjs").PublicationSourceFact | undefined} source
 * @param {import("./full-release-publication-contract.mjs").PublicationSelection} operation
 */
function validatePublicationOperation(source, operation) {
  const original = source?.publicationSelection;
  if (!source || !original || source.validationPurpose !== "publish") {
    throw new Error("Publication operation requires an authenticated publish admission.");
  }
  if (publicationSourceJson(original) === publicationSourceJson(operation)) {
    return;
  }
  if (
    original.pluginPublishScope !== "all-publishable" ||
    operation.publishOpenclawNpm ||
    operation.pluginPublishScope !== "selected" ||
    !Array.isArray(operation.plugins) ||
    operation.plugins.length === 0 ||
    new Set(operation.plugins).size !== operation.plugins.length ||
    publicationSourceJson({
      ...operation,
      publishOpenclawNpm: original.publishOpenclawNpm,
      pluginPublishScope: original.pluginPublishScope,
      plugins: original.plugins,
    }) !== publicationSourceJson(original) ||
    operation.plugins.some(
      (name) =>
        !source.projection?.packages.some(
          (entry) =>
            entry.name === name &&
            name.startsWith("@openclaw/") &&
            entry.targets.some((target) => target === "npm" || target === "clawhub"),
        ),
    )
  ) {
    throw new Error(
      "Publication operation is not a covered plugin-only subset of the original admission.",
    );
  }
}

/** Publication eligibility over facts obtained by this module's strict traversal. */
function validatePublicationEvidence(options, evidence) {
  const {
    expectedRepository,
    expectedRunId,
    expectedRunAttempt,
    expectedTargetSha,
    expectedReleaseTag,
    expectedPublicationSelection,
    expectedPublicationOperation,
    expectedCoreNpmPublication,
  } = options;
  if (
    expectedReleaseTag?.includes("-alpha.") ||
    expectedCoreNpmPublication?.npmDistTag === "alpha"
  ) {
    throw new Error("Alpha releases are retired; use a beta prerelease instead.");
  }
  if (
    [expectedPublicationSelection, expectedPublicationOperation, expectedCoreNpmPublication].filter(
      Boolean,
    ).length > 1
  ) {
    throw new Error("Publication evidence requires one actual consumption selection.");
  }
  const run = normalizeFullReleaseValidationRun(options.run);
  const current = evidence.current;
  const manifest = current.manifest;
  // Bind the transport observation to the exact run authenticated by the owner.
  // Qualification, workflow provenance, coverage and waivers are not reinterpreted here.
  if (
    evidence.repository !== expectedRepository ||
    current.runId !== String(expectedRunId) ||
    current.targetSha !== expectedTargetSha ||
    current.runAttempt !== run.runAttempt ||
    (expectedRunAttempt !== undefined && current.runAttempt !== Number(expectedRunAttempt)) ||
    run.databaseId !== current.runId ||
    run.headSha !== current.workflowSha ||
    run.headBranch !== current.workflowRef ||
    run.workflowPath !== current.workflowPath ||
    run.repository !== evidence.repository ||
    run.status !== current.status ||
    run.conclusion !== current.conclusion ||
    run.event !== "workflow_dispatch"
  ) {
    throw new Error("Publication consumer differs from the authenticated release run.");
  }
  if (current.conclusion !== "success") {
    throw new Error("Required release validation evidence did not pass.");
  }
  // v2 remains readable by diagnostics, but was never a publication contract.
  if (manifest.version !== 3 && manifest.version !== 4) {
    throw new Error("Publication requires a version 3 or 4 release manifest.");
  }
  resolveReleasePublishInputs(manifest);
  const sourceAdmission = manifest.sourceAdmission;
  const publicationAdmission = manifest.publicationAdmission;
  const coveragePolicy = evidence.qualification.coveragePolicy;
  const coveredReleaseTag =
    coveragePolicy === "npm-stable-v1"
      ? resolveReleaseContextIdentity(
          scalarString(manifest.validationInputs?.targetContextRef) ||
            scalarString(manifest.targetRef),
          scalarString(manifest.validationInputs?.targetVersion),
        )?.releaseTag
      : "v" + scalarString(manifest.validationInputs?.targetVersion);
  if (
    coveragePolicy &&
    (manifest.version !== 4 || !coveredReleaseTag || expectedReleaseTag !== coveredReleaseTag)
  ) {
    throw new Error(
      "Release coverage policy requires version 4 evidence for the exact publication tag.",
    );
  }
  if (sourceAdmission) {
    // Historical recovery must not acquire a new publication-selection contract.
    const selected =
      typeof expectedPublicationSelection === "function"
        ? expectedPublicationSelection()
        : expectedPublicationSelection;
    if (
      sourceAdmission.validationPurpose !== "publish" ||
      (selected &&
        publicationSourceJson(sourceAdmission.publicationSelection) !==
          publicationSourceJson(selected))
    ) {
      const windowsRemediation =
        selected?.windowsNodeTag && !sourceAdmission.publicationSelection?.windowsNodeTag
          ? " Remove --windows-node-tag when reusing this FRV and attach Windows afterward via windows-node-release.yml, or obtain new FRV evidence admitted with Windows selected."
          : "";
      throw new Error(
        `New-contract nonpublish or differently selected evidence cannot prepare publication.${windowsRemediation}`,
      );
    }
    if (expectedCoreNpmPublication) {
      const selection = sourceAdmission.publicationSelection;
      if (
        Object.keys(expectedCoreNpmPublication).join(",") !== "npmDistTag" ||
        selection?.publishOpenclawNpm !== true ||
        selection.npmDistTag !== expectedCoreNpmPublication.npmDistTag ||
        !sourceAdmission.projection?.packages.some(
          (entry) =>
            entry.name === "openclaw" &&
            entry.version === sourceAdmission.projection.version &&
            entry.targets.includes("npm"),
        )
      ) {
        throw new Error("Publication evidence does not cover the actual core npm operation.");
      }
    }
  }

  if (manifest.publicationAdmissionContract || expectedPublicationOperation) {
    const contextIdentity = sourceAdmission?.projection
      ? resolveReleaseContextIdentity(
          sourceAdmission.targetContextRef,
          sourceAdmission.projection.version,
        )
      : null;
    const sourceReleaseTag =
      contextIdentity?.releaseTag ??
      (!manifest.validationInputs?.targetContextRef && sourceAdmission?.projection
        ? "v" + sourceAdmission.projection.version
        : undefined);
    if (
      (manifest.publicationAdmissionContract && !publicationAdmission) ||
      (!expectedPublicationSelection &&
        !expectedPublicationOperation &&
        !expectedCoreNpmPublication) ||
      sourceReleaseTag !== expectedReleaseTag
    ) {
      throw new Error("B publication evidence requires the actual selection and release tag.");
    }
  }
  if (expectedPublicationOperation) {
    validatePublicationOperation(
      sourceAdmission,
      typeof expectedPublicationOperation === "function"
        ? expectedPublicationOperation()
        : expectedPublicationOperation,
    );
  }
  const proof = current.workflowRefProof;
  const source =
    evidence.qualification.kind === "recovery"
      ? "receipt-backed-recovery-v1"
      : evidence.qualification.kind === "direct"
        ? "candidate-owned-admission-v1"
        : proof === "manifest-v3-protected-tag-tooling-lineage"
          ? "sha-pinned-protected-tag-main-ancestor"
          : proof === "manifest-v3-protected-tag-exact-sha"
            ? "sha-pinned-protected-tag"
            : isShaPinnedReleaseValidationBranch(current.workflowRef)
              ? "sha-pinned-main"
              : "direct";
  return { run, source, coveragePolicy };
}

/**
 * Authenticate once, then adapt that same current manifest to the real consumer.
 * Historical producers retain their exact-source validation without a registry sweep.
 * @param {Omit<FullReleaseValidationEvidenceOptions, "manifest"> & {
 *   manifest?: FullReleaseValidationManifest,
 *   manifestPath?: string,
 *   verifierSourceSha?: string,
 *   verifierSourceContent?: string | Uint8Array,
 *   npmPreflightLineage?: { qualificationSha: string, producerRunId: string, producerRunAttempt: string },
 * }} options
 * @param {ReturnType<typeof createReleaseEvidenceClient>} [client]
 */
export async function authenticateFullReleaseValidationEvidence(options, client) {
  const evidenceClient = client ?? createReleaseEvidenceClient(options.expectedRepository);
  const run = normalizeFullReleaseValidationRun(options.run);
  const evidence = await validateReleaseRunEvidence(
    {
      repository: options.expectedRepository,
      runId: String(options.expectedRunId),
      manifestPath: options.manifestPath,
      trustedWorkflowFullRef: options.expectedTrustedWorkflowFullRef,
      trustedWorkflowRef:
        options.expectedTrustedWorkflowFullRef?.replace(/^refs\/(?:heads|tags)\//u, "") ?? "main",
      trustedWorkflowSha: options.expectedTrustedWorkflowSha,
      verifierSourceSha: options.verifierSourceSha,
      verifierSourceContent: options.verifierSourceContent,
    },
    evidenceClient,
  );
  if (evidence.current.conclusion !== "success") {
    throw new Error("Required release validation evidence did not pass.");
  }
  if (evidence.current.runAttempt !== run.runAttempt) {
    throw new Error("Authenticated publication evidence attempt differs from the consumer.");
  }
  const manifest = options.manifest ?? evidence.current.manifest;
  if (
    publicationObservationJson(manifest) !== publicationObservationJson(evidence.current.manifest)
  ) {
    throw new Error("Supplied publication evidence differs from the authenticated manifest.");
  }
  const forPublication = (consumption) => {
    if (
      (consumption.expectedTrustedWorkflowFullRef ?? "refs/heads/main") !==
        (options.expectedTrustedWorkflowFullRef ?? "refs/heads/main") ||
      consumption.expectedTrustedWorkflowSha !== options.expectedTrustedWorkflowSha
    ) {
      throw new Error("Publication tooling context differs from the authenticated qualification.");
    }
    const suppliedManifest = consumption.manifest ?? evidence.current.manifest;
    if (
      publicationObservationJson(suppliedManifest) !==
      publicationObservationJson(evidence.current.manifest)
    ) {
      throw new Error("Supplied publication evidence differs from the authenticated manifest.");
    }
    revalidateAuthority?.();
    return validatePublicationEvidence(consumption, evidence);
  };
  const result = validatePublicationEvidence(options, evidence);
  const revalidateAuthority = candidateArtifactAuthority(manifest, evidence, evidenceClient);
  if (options.npmPreflightLineage) {
    // Retain this owner's authenticated evidence across the consumer handoff.
    // Serialized or caller-supplied evidence never replaces this traversal.
    const { validateNpmPreflightQualification, verifyNpmPreflightPublicationLineage } =
      await import("./npm-preflight-tooling-identity.mjs");
    const lineage = {
      manifest,
      repository: options.expectedRepository,
      sourceSha: options.expectedTargetSha,
      toolingSha: options.npmPreflightLineage.qualificationSha,
      publisherSha: options.expectedTrustedWorkflowSha,
      publisherFullRef: options.expectedTrustedWorkflowFullRef,
      producerRunId: options.npmPreflightLineage.producerRunId,
      producerRunAttempt: options.npmPreflightLineage.producerRunAttempt,
    };
    if (evidence.qualification.kind !== "historical") {
      validateCandidateOwnedArtifactBinding(
        manifest,
        lineage.sourceSha,
        lineage.toolingSha,
        evidence,
      );
      validateNpmPreflightQualification(lineage);
    } else {
      await verifyNpmPreflightPublicationLineage(lineage);
    }
    // Imports and lineage checks can wait. Refresh live admission at the final
    // handoff, not just before the original full artifact authentication.
    revalidateAuthority?.();
  }
  return {
    ...result,
    evidence,
    qualification: evidence.qualification,
    forPublication,
    publicationAdmission: manifest.publicationAdmission ?? null,
    revalidateAuthority,
    publicationAuthority: candidateArtifactAuthorityRecord(manifest, evidence),
  };
}

function candidateArtifactAuthority(manifest, evidence, evidenceClient) {
  const authority = candidateArtifactAuthorityRecord(manifest, evidence);
  if (!authority) {
    return undefined;
  }
  const revalidate = () => revalidateCandidateArtifactAuthority(authority, evidenceClient);
  revalidate();
  return revalidate;
}

function candidateArtifactAuthorityRecord(manifest, evidence) {
  const descriptor =
    manifest?.sourceAdmission?.qualificationAdmission ??
    manifest?.receiptRecovery?.qualificationAdmission;
  if (!descriptor) {
    return undefined;
  }
  if (!evidence.qualification.admission) {
    throw new Error("Authenticated candidate admission authority is missing");
  }
  // Retain authenticated identities, not live permission or ref verdicts.
  return structuredClone({
    descriptor,
    admission: evidence.qualification.admission,
    recoveryProducer: manifest.receiptRecovery
      ? {
          runId: String(manifest.runId),
          runAttempt: Number(manifest.runAttempt),
          fullRef: manifest.workflowFullRef,
          sha: manifest.workflowSha,
        }
      : null,
  });
}

// Only an authenticated preview carrier may restore this owner-generated record.
// It carries the operator identities, never their current permission verdict.
export function revalidateCandidateArtifactAuthority(authority, evidenceClient) {
  if (authority) {
    evidenceClient.revalidateQualificationAdmissionAuthority(authority);
    if (authority.recoveryProducer) {
      if (evidenceClient.verifyReceiptRecoveryAuthority) {
        evidenceClient.verifyReceiptRecoveryAuthority(authority.recoveryProducer);
      } else {
        verifyReceiptRecoveryAuthority(authority.descriptor.repository, authority.recoveryProducer);
      }
    }
  }
}

function validateCandidateOwnedArtifactBinding(manifest, candidateSha, qualificationSha, evidence) {
  const qualification = evidence.qualification;
  if (
    qualification.kind === "historical" ||
    candidateSha !== qualificationSha ||
    qualification.candidateSha !== candidateSha ||
    qualification.qualificationSha !== qualificationSha ||
    evidence.current.runAttempt !== Number(manifest.runAttempt) ||
    evidence.current.conclusion !== "success" ||
    !isDeepStrictEqual(evidence.current.manifest, sortJsonValueKeys(manifest))
  ) {
    throw new Error("Publication artifact is not bound to authenticated candidate qualification");
  }
  if (
    evidence.current.manifest.sourceAdmission.validationPurpose !== "publish" ||
    !evidence.current.manifest.publicationAdmission
  ) {
    throw new Error("Publication artifacts require publish-purpose admitted qualification");
  }
}

// Publication consumers replace ancestry only after the full FRV owner has
// authenticated its P admission, frozen coverage, exact attempts and artifacts.
export async function authenticateCandidateOwnedArtifact({
  manifest,
  repository,
  candidateSha,
  qualificationSha,
  publisherSha,
  publisherFullRef = "refs/heads/main",
  client,
}) {
  const recovery = manifest?.receiptRecovery;
  if (!manifest?.sourceAdmission?.qualificationAdmission && !recovery) {
    return null;
  }
  const evidenceClient = client ?? createReleaseEvidenceClient(repository);
  const evidence = await validateReleaseRunEvidence(
    {
      repository,
      runId: String(manifest.runId),
      trustedWorkflowFullRef: publisherFullRef,
      trustedWorkflowRef: publisherFullRef.replace(/^refs\/(?:heads|tags)\//u, ""),
      trustedWorkflowSha: publisherSha,
      verifierSourceSha: publisherSha,
      verifierSourceContent: readFileSync(new URL("./release-ci-summary.mjs", import.meta.url)),
    },
    evidenceClient,
  );
  validateCandidateOwnedArtifactBinding(manifest, candidateSha, qualificationSha, evidence);
  const revalidateAuthority = candidateArtifactAuthority(manifest, evidence, evidenceClient);
  return { ...evidence, revalidateAuthority };
}

/** @returns {import("./full-release-publication-contract.mjs").PublicationSelection} */
function publisherOperationFromEnvironment() {
  const plugins = (process.env.RELEASE_PLUGINS ?? "").split(/[\s,]+/u).filter(Boolean);
  const subset = process.env.PLUGIN_PUBLISH_SCOPE === "selected";
  const publishOpenclawNpm = process.env.PUBLISH_OPENCLAW_NPM === "true";
  // Normalize the unchanged route/channel/Windows operands as a full intent.
  // Only authenticated operation validation below may narrow that intent.
  const { publicationSelection } = normalizePublicationIntent(
    "publish",
    JSON.stringify({
      route: process.env.PREPARED_PLUGINS?.trim()
        ? "prepared"
        : process.env.RELEASE_NPM_DIST_TAG === "extended-stable"
          ? "extended-stable"
          : "normal",
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      publishOpenclawNpm: subset ? true : publishOpenclawNpm,
      pluginPublishScope: subset ? "all-publishable" : process.env.PLUGIN_PUBLISH_SCOPE,
      plugins: subset ? [] : plugins,
      ...(process.env.WINDOWS_NODE_TAG
        ? {
            windowsNodeTag: process.env.WINDOWS_NODE_TAG,
            windowsNodeInstallerDigests: JSON.parse(
              process.env.WINDOWS_NODE_INSTALLER_DIGESTS ?? "",
            ),
          }
        : {}),
    }),
  );
  if (!publicationSelection) {
    throw new Error("Publisher requires a publication selection.");
  }
  return subset
    ? { ...publicationSelection, publishOpenclawNpm, pluginPublishScope: "selected", plugins }
    : publicationSelection;
}

async function main() {
  const manifestPath = process.env.MANIFEST_FILE ?? "";
  if (!manifestPath) {
    throw new Error("MANIFEST_FILE is required.");
  }
  const run = JSON.parse(await text(process.stdin));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const consumer = process.env.PUBLICATION_CONSUMER ?? "";
  const coreProjection = consumer === "core-npm" || consumer === "docker-only";
  const boundedOperation =
    consumer === "publisher" &&
    process.env.PLUGIN_PUBLISH_SCOPE === "selected" &&
    manifest.sourceAdmission?.publicationSelection !== undefined;
  if (consumer && !["publisher", "core-npm", "docker-only"].includes(consumer)) {
    throw new Error("Unknown publication evidence consumer.");
  }
  if (
    consumer === "docker-only" &&
    (process.env.PUBLISH_DOCKER_ONLY !== "true" || process.env.PUBLISH_OPENCLAW_NPM !== "false")
  ) {
    throw new Error("Docker-only evidence consumption requires its actual recovery operands.");
  }
  if (consumer === "publisher" && process.env.PUBLISH_DOCKER_ONLY === "true") {
    throw new Error("Contradictory Docker-only publication operands.");
  }
  const result = await authenticateFullReleaseValidationEvidence({
    run,
    manifest,
    expectedRepository: process.env.GITHUB_REPOSITORY,
    expectedRunId: process.env.FULL_RELEASE_VALIDATION_RUN_ID,
    expectedRunAttempt: process.env.FULL_RELEASE_VALIDATION_RUN_ATTEMPT,
    expectedTargetSha: process.env.EXPECTED_SHA,
    expectedReleaseTag: process.env.RELEASE_TAG,
    expectedTrustedWorkflowFullRef: process.env.TRUSTED_WORKFLOW_FULL_REF,
    expectedTrustedWorkflowSha: process.env.TRUSTED_WORKFLOW_SHA,
    expectedCoreNpmPublication: coreProjection
      ? { npmDistTag: process.env.RELEASE_NPM_DIST_TAG ?? "" }
      : undefined,
    expectedPublicationSelection:
      consumer === "publisher" && !boundedOperation ? publisherOperationFromEnvironment : undefined,
    expectedPublicationOperation: boundedOperation ? publisherOperationFromEnvironment : undefined,
    manifestPath,
    npmPreflightLineage:
      process.env.VERIFY_NPM_PREFLIGHT_LINEAGE === "true"
        ? {
            qualificationSha: process.env.PREFLIGHT_WORKFLOW_SHA,
            producerRunId: process.env.PREFLIGHT_RUN_ID,
            producerRunAttempt: process.env.PREFLIGHT_RUN_ATTEMPT,
          }
        : undefined,
    verifierSourceSha: process.env.WORKFLOW_SHA ?? process.env.GITHUB_SHA,
    verifierSourceContent: readFileSync(
      process.env.STRICT_VALIDATOR_FILE ??
        fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url)),
    ),
  });
  console.log(
    `Using full release validation run ${result.run.databaseId} (${result.source}): ${result.run.url}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
