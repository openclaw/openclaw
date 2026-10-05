#!/usr/bin/env node
// Binds Full Release Validation run metadata to its supported evidence manifest.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  normalizePublicationIntent,
  publicationAdmissionContract,
  publicationObservationJson,
  publicationSourceContract,
  publicationSourceJson,
  validatePublicationAdmissionBinding,
  validatePublicationSourceBinding,
} from "./full-release-publication-contract.mjs";
import {
  normalizeReleaseCoveragePolicy,
  isSplitChangelogEvidenceDelta,
  SPLIT_CHANGELOG_EVIDENCE_REUSE_POLICY,
  validateReleaseManifestAdvisoryJobs,
  validateRetiredReleaseRetryFields,
} from "./full-release-validation-policy.mjs";
import { sortJsonValueKeys } from "./lib/canonical-json.mjs";
import { resolveReleaseContextIdentity } from "./lib/release-context.mjs";
import { resolveReleasePublishInputs } from "./lib/release-publish-inputs.mjs";
import { createReleaseEvidenceClient, validateReleaseRunEvidence } from "./release-ci-summary.mjs";
import { qualificationAdmissionContract } from "./release-qualification-coverage.mjs";

const FULL_RELEASE_WORKFLOW = "Full Release Validation";
const FULL_RELEASE_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PINNED_BRANCH_PATTERN = /^release-ci\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const TRUSTED_RELEASE_PUBLISH_TAG_PATTERN =
  /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";

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

/** @param {unknown} value */
function displayValue(value) {
  if (value === null || value === undefined) {
    return "<missing>";
  }
  const scalar = scalarString(value);
  if (scalar) {
    return scalar;
  }
  try {
    return JSON.stringify(value) ?? "<unserializable>";
  } catch {
    return "<unserializable>";
  }
}

/**
 * @typedef {object} StrictReleaseEvidence
 * @property {unknown} [schema]
 * @property {unknown} [valid]
 * @property {{ runId?: unknown, targetSha?: unknown, runAttempt?: unknown, manifest?: unknown, workflowRefProof?: unknown }} [current]
 * @property {{ runId?: unknown, targetSha?: unknown, manifest?: unknown }} [root]
 * @property {{ changedPaths?: unknown, evidenceSha?: unknown, policy?: unknown, rootRunId?: unknown, selectedRunId?: unknown } | null} [evidenceReuse]
 * @property {{ allRequiredSucceeded?: unknown }} [conclusions]
 */
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
 * @property {string} [expectedWorkflowBranch]
 * @property {import("./full-release-publication-contract.mjs").PublicationSelection | (() => import("./full-release-publication-contract.mjs").PublicationSelection)} [expectedPublicationSelection]
 * @property {{ npmDistTag: string }} [expectedCoreNpmPublication]
 * @property {(sha: string) => string} [getWorkflowSource]
 * @property {(sha: string) => boolean} [isTrustedMainAncestor]
 * @property {(params: { repository: string, runId: string, targetSha: string }) => StrictReleaseEvidence} [validateEvidenceReuseStrictly]
 */

function normalizeWorkflowPathRef(ref) {
  if (!ref || ref.startsWith("refs/")) {
    return ref;
  }
  return `refs/heads/${ref}`;
}

export function normalizeFullReleaseValidationRun(run) {
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

/** @param {FullReleaseValidationEvidenceOptions} options */
export function validateFullReleaseValidationEvidence({
  run: rawRun,
  manifest,
  expectedRepository,
  expectedRunId,
  expectedRunAttempt,
  expectedTargetSha,
  expectedReleaseTag,
  expectedTrustedWorkflowFullRef,
  expectedTrustedWorkflowSha,
  expectedWorkflowBranch,
  expectedPublicationSelection,
  expectedCoreNpmPublication,
  getWorkflowSource,
  isTrustedMainAncestor,
  validateEvidenceReuseStrictly,
}) {
  if (
    expectedReleaseTag?.includes("-alpha.") ||
    expectedCoreNpmPublication?.npmDistTag === "alpha" ||
    expectedTrustedWorkflowFullRef?.includes("tideclaw/alpha/")
  ) {
    throw new Error("Alpha releases are retired; use a beta prerelease instead.");
  }
  if (expectedPublicationSelection && expectedCoreNpmPublication) {
    throw new Error("Publication evidence requires one actual consumption selection.");
  }
  const run = normalizeFullReleaseValidationRun(rawRun);
  const trustedWorkflowFullRef = expectedTrustedWorkflowFullRef ?? "refs/heads/main";
  const protectedTag = TRUSTED_RELEASE_PUBLISH_TAG_PATTERN.exec(trustedWorkflowFullRef);
  if (protectedTag) {
    if (!SHA_PATTERN.test(expectedTrustedWorkflowSha ?? "")) {
      throw new Error("Protected release-publish evidence requires an exact trusted workflow SHA.");
    }
    if (expectedTrustedWorkflowSha.slice(0, 12) !== protectedTag[1]) {
      throw new Error("Protected release-publish tag does not match its trusted workflow SHA.");
    }
  } else if (
    !trustedWorkflowFullRef.startsWith("refs/heads/") ||
    trustedWorkflowFullRef.startsWith("refs/heads/release-publish/")
  ) {
    throw new Error("Trusted release-publish workflow ref must be an exact protected tag.");
  }
  const checks = [
    ["databaseId", String(expectedRunId)],
    ["workflowName", FULL_RELEASE_WORKFLOW],
    ["workflowPath", FULL_RELEASE_WORKFLOW_PATH],
    ["repository", expectedRepository],
    ["event", "workflow_dispatch"],
    ["status", "completed"],
    ["conclusion", "success"],
  ];
  for (const [key, expected] of checks) {
    if (run[key] !== expected) {
      throw new Error(
        `Referenced full release validation run ${expectedRunId} must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
      );
    }
  }
  if (!Number.isInteger(run.runAttempt) || run.runAttempt < 1) {
    throw new Error(`Referenced full release validation run ${expectedRunId} has invalid attempt.`);
  }
  if (expectedRunAttempt !== undefined && run.runAttempt !== Number(expectedRunAttempt)) {
    throw new Error("Referenced full release validation attempt differs from the consumer.");
  }
  if (!SHA_PATTERN.test(run.headSha ?? "")) {
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has invalid head SHA.`,
    );
  }
  const expectedQualifiedRef = `refs/heads/${run.headBranch}`;
  const workflowQualifiedRef = normalizeWorkflowPathRef(run.workflowQualifiedRef);
  if (workflowQualifiedRef && workflowQualifiedRef !== expectedQualifiedRef) {
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has workflow path ref ${run.workflowQualifiedRef}, expected ${expectedQualifiedRef}.`,
    );
  }

  if (manifest.version !== 3 && manifest.version !== 4) {
    throw new Error(
      `Full release validation manifest must use version 3 or 4, got ${displayValue(manifest.version)}.`,
    );
  }
  validateRetiredReleaseRetryFields(manifest);
  resolveReleasePublishInputs(manifest);
  if (
    manifest.validationInputs?.knownFlakyJobsJson !== undefined &&
    manifest.validationInputs.knownFlakyJobsJson !== "[]"
  ) {
    throw new Error("release validation manifest knownFlakyJobsJson must be empty");
  }
  const manifestChecks = [
    ["workflowName", FULL_RELEASE_WORKFLOW],
    ["runId", String(expectedRunId)],
    ["runAttempt", String(run.runAttempt)],
    ["workflowRef", run.headBranch],
    ["workflowSha", run.headSha],
    ["workflowFullRef", expectedQualifiedRef],
    ["workflowRefType", "branch"],
    ["targetSha", expectedTargetSha],
  ];
  for (const [key, expected] of manifestChecks) {
    if (scalarString(manifest[key]) !== expected) {
      throw new Error(
        `Full release validation manifest ${key} mismatch: expected ${expected}, got ${displayValue(manifest[key])}.`,
      );
    }
  }
  const workflowSource = getWorkflowSource
    ? getWorkflowSource(run.headSha)
    : createReleaseEvidenceClient(expectedRepository).getWorkflowSource(run.headSha);
  const contract = publicationSourceContract(workflowSource);
  const registryContract = publicationAdmissionContract(workflowSource);
  if (manifest.sourceAdmissionContract !== contract) {
    throw new Error(
      "Publication evidence differs from its immutable source-admission workflow contract.",
    );
  }
  const sourceAdmission = validatePublicationSourceBinding(manifest, {
    sourceAdmissionContract: contract,
    repository: expectedRepository,
    targetSha: expectedTargetSha,
    parentRunId: String(expectedRunId),
  });
  if (manifest.qualificationCoverage && !sourceAdmission?.qualificationAdmission) {
    throw new Error("Candidate-owned publication evidence omitted admission");
  }
  const coveragePolicy = manifest.qualificationCoverage
    ? sourceAdmission?.coverage.coverage_policy || undefined
    : normalizeReleaseCoveragePolicy({
        ...manifest.validationInputs,
        candidateVersion: manifest.candidateBinding?.package?.version,
        releaseProfile: manifest.releaseProfile,
        rerunGroup: manifest.rerunGroup,
        runReleaseSoak: manifest.runReleaseSoak,
      });
  const coveredReleaseTag =
    coveragePolicy === "npm-stable-v1"
      ? resolveReleaseContextIdentity(
          scalarString(manifest.validationInputs?.targetContextRef) ||
            scalarString(manifest.targetRef),
          scalarString(manifest.validationInputs?.targetVersion),
        )?.releaseTag
      : `v${scalarString(manifest.validationInputs?.targetVersion)}`;
  if (
    coveragePolicy &&
    (manifest.version !== 4 || !coveredReleaseTag || expectedReleaseTag !== coveredReleaseTag)
  ) {
    throw new Error(
      "Release coverage policy requires version 4 evidence for the exact publication tag.",
    );
  }

  if (manifest.publicationAdmissionContract !== registryContract) {
    throw new Error("Publication evidence differs from its immutable registry-admission contract.");
  }
  if (
    qualificationAdmissionContract(workflowSource) === "1" &&
    sourceAdmission?.validationPurpose === "publish" &&
    !sourceAdmission.qualificationAdmission
  ) {
    throw new Error(
      "Frozen publication qualification requires independently authenticated P admission",
    );
  }
  const publicationAdmission = validatePublicationAdmissionBinding(manifest, {
    publicationAdmissionContract: registryContract,
  });
  let strictEvidence;
  const strict = () => {
    if (!strictEvidence) {
      if (typeof validateEvidenceReuseStrictly !== "function") {
        throw new Error("Publication evidence requires authenticated strict validation.");
      }
      strictEvidence = validateEvidenceReuseStrictly({
        repository: expectedRepository,
        runId: String(expectedRunId),
        targetSha: expectedTargetSha,
      });
    }
    return strictEvidence;
  };
  validateReleaseManifestAdvisoryJobs(manifest);
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
      throw new Error(
        "New-contract nonpublish or differently selected evidence cannot prepare publication.",
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
  if (registryContract) {
    const contextIdentity = sourceAdmission?.projection
      ? resolveReleaseContextIdentity(
          sourceAdmission.targetContextRef,
          sourceAdmission.projection.version,
        )
      : null;
    const sourceReleaseTag =
      contextIdentity?.releaseTag ??
      (!manifest.validationInputs?.targetContextRef && sourceAdmission?.projection
        ? `v${sourceAdmission.projection.version}`
        : undefined);
    if (
      !publicationAdmission ||
      (!expectedPublicationSelection && !expectedCoreNpmPublication) ||
      sourceReleaseTag !== expectedReleaseTag
    ) {
      throw new Error("B publication evidence requires the actual selection and release tag.");
    }
    const authenticated = strict();
    if (
      authenticated.valid !== true ||
      authenticated.current?.runId !== String(expectedRunId) ||
      authenticated.current?.targetSha !== expectedTargetSha ||
      authenticated.current?.runAttempt !== run.runAttempt ||
      authenticated.conclusions?.allRequiredSucceeded !== true ||
      publicationObservationJson(authenticated.current?.manifest) !==
        publicationObservationJson(manifest)
    ) {
      throw new Error("B publication evidence differs from its authenticated retained manifest.");
    }
  }

  const candidateOwned = sourceAdmission?.qualificationAdmission !== undefined;
  if (candidateOwned) {
    const authenticated = strict();
    if (
      authenticated.valid !== true ||
      authenticated.current?.runId !== String(expectedRunId) ||
      authenticated.current?.runAttempt !== run.runAttempt ||
      authenticated.current?.targetSha !== expectedTargetSha ||
      authenticated.current?.workflowRefProof !== "candidate-owned-admission-v1" ||
      authenticated.conclusions?.allRequiredSucceeded !== true ||
      publicationObservationJson(authenticated.current?.manifest) !==
        publicationObservationJson(manifest)
    ) {
      throw new Error(
        "Candidate-owned qualification requires authenticated complete frozen evidence",
      );
    }
  }
  const pinnedMatch = PINNED_BRANCH_PATTERN.exec(run.headBranch ?? "");
  if (!pinnedMatch) {
    if (protectedTag) {
      throw new Error(
        "Protected-tag release evidence must use a canonical release-ci producer branch.",
      );
    }
    if (run.headBranch?.startsWith("release-ci/")) {
      throw new Error(
        `Referenced full release validation run ${expectedRunId} has untrusted head branch ${run.headBranch}.`,
      );
    }
    const directBranches = new Set(["main", expectedWorkflowBranch].filter(Boolean));
    if (directBranches.has(run.headBranch)) {
      if (run.headBranch === "main" && !isTrustedMainAncestor?.(run.headSha)) {
        throw new Error(
          `Direct main validation workflow ${run.headSha} is not reachable from current main.`,
        );
      }
      return { run, source: "direct", coveragePolicy };
    }
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has untrusted head branch ${run.headBranch ?? "<missing>"}.`,
    );
  }
  if (pinnedMatch[1] !== run.headSha.slice(0, 12)) {
    throw new Error(
      `SHA-pinned validation branch ${run.headBranch} does not match workflow SHA ${run.headSha}.`,
    );
  }
  if (manifest.targetRef !== expectedTargetSha) {
    throw new Error(
      `SHA-pinned validation target ref mismatch: expected ${expectedTargetSha}, got ${displayValue(manifest.targetRef)}.`,
    );
  }
  // The protected tag authenticates the current publisher. An older validation
  // producer remains trusted only through its independent current-main lineage.
  const historicalProtectedProducer = protectedTag && run.headSha !== expectedTrustedWorkflowSha;
  if (
    !candidateOwned &&
    (historicalProtectedProducer || !protectedTag) &&
    !isTrustedMainAncestor?.(run.headSha)
  ) {
    const subject = protectedTag
      ? "Protected-tag release evidence workflow SHA"
      : "SHA-pinned validation workflow";
    throw new Error(`${subject} ${run.headSha} is not reachable from current main.`);
  }
  const source = candidateOwned
    ? "candidate-owned-admission-v1"
    : protectedTag
      ? historicalProtectedProducer
        ? "sha-pinned-protected-tag-main-ancestor"
        : "sha-pinned-protected-tag"
      : "sha-pinned-main";
  if (Object.hasOwn(manifest, "evidenceReuse")) {
    const reuse = manifest.evidenceReuse;
    const exactTarget =
      reuse?.policy === EXACT_TARGET_EVIDENCE_REUSE_POLICY &&
      reuse.evidenceSha === expectedTargetSha &&
      Array.isArray(reuse.changedPaths) &&
      reuse.changedPaths.length === 0;
    const changelogOnly =
      reuse?.policy === CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY &&
      reuse.evidenceSha !== expectedTargetSha &&
      Array.isArray(reuse.changedPaths) &&
      reuse.changedPaths.length === 1 &&
      reuse.changedPaths[0] === "CHANGELOG.md";
    const splitChangelog =
      reuse?.policy === SPLIT_CHANGELOG_EVIDENCE_REUSE_POLICY &&
      reuse.evidenceSha !== expectedTargetSha &&
      isSplitChangelogEvidenceDelta(
        reuse.changedPaths,
        manifest.candidateBinding?.package?.version ?? manifest.validationInputs?.targetVersion,
      );
    if (
      !reuse ||
      typeof reuse !== "object" ||
      Array.isArray(reuse) ||
      (!exactTarget && !changelogOnly && !splitChangelog) ||
      !/^[1-9][0-9]*$/u.test(scalarString(reuse.runId)) ||
      !/^[1-9][0-9]*$/u.test(scalarString(reuse.selectedRunId))
    ) {
      throw new Error("SHA-pinned validation evidence reuse is invalid.");
    }
    if (typeof validateEvidenceReuseStrictly !== "function") {
      throw new Error("SHA-pinned validation evidence reuse requires strict chain validation.");
    }
    const reusedEvidence = strict();
    if (
      reusedEvidence?.schema !== `openclaw.release-validation-evidence/v${manifest.version}` ||
      reusedEvidence.valid !== true ||
      scalarString(reusedEvidence.current?.runId) !== String(expectedRunId) ||
      reusedEvidence.current?.targetSha !== expectedTargetSha ||
      reusedEvidence.root?.targetSha !== reuse.evidenceSha ||
      reusedEvidence.evidenceReuse?.evidenceSha !== reuse.evidenceSha ||
      reusedEvidence.evidenceReuse?.policy !== reuse.policy ||
      JSON.stringify(reusedEvidence.evidenceReuse?.changedPaths) !==
        JSON.stringify(reuse.changedPaths) ||
      scalarString(reusedEvidence.evidenceReuse?.rootRunId) !== scalarString(reuse.runId) ||
      scalarString(reusedEvidence.evidenceReuse?.selectedRunId) !==
        scalarString(reuse.selectedRunId) ||
      reusedEvidence.conclusions?.allRequiredSucceeded !== true
    ) {
      throw new Error("SHA-pinned validation evidence reuse failed strict chain validation.");
    }
  }
  return { run, source, coveragePolicy };
}

/**
 * Authenticate once, then adapt that same current manifest to the real consumer.
 * Historical producers retain their exact-source validation without a registry sweep.
 * @param {Omit<FullReleaseValidationEvidenceOptions, "manifest" | "getWorkflowSource" | "validateEvidenceReuseStrictly"> & {
 *   manifest?: FullReleaseValidationManifest,
 *   manifestPath?: string,
 *   verifierSourceSha?: string,
 *   verifierSourceContent?: string | Uint8Array,
 * }} options
 * @param {ReturnType<typeof createReleaseEvidenceClient>} [client]
 */
export async function authenticateFullReleaseValidationEvidence(options, client) {
  const evidenceClient = client ?? createReleaseEvidenceClient(options.expectedRepository);
  const run = normalizeFullReleaseValidationRun(options.run);
  const workflowSources = new Map();
  const getWorkflowSource = (sha) => {
    if (!workflowSources.has(sha)) {
      workflowSources.set(sha, evidenceClient.getWorkflowSource(sha));
    }
    return workflowSources.get(sha);
  };
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
    { ...evidenceClient, getWorkflowSource },
  );
  if (!evidence.conclusions.allRequiredSucceeded) {
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
  const result = validateFullReleaseValidationEvidence({
    ...options,
    manifest,
    getWorkflowSource,
    validateEvidenceReuseStrictly: () => evidence,
  });
  return { ...result, evidence, publicationAdmission: manifest.publicationAdmission ?? null };
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
  if (!manifest?.sourceAdmission?.qualificationAdmission) {
    return null;
  }
  if (
    candidateSha !== qualificationSha ||
    manifest.targetSha !== candidateSha ||
    manifest.workflowSha !== qualificationSha
  ) {
    throw new Error("Candidate-owned artifact source and qualification SHA differ");
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
  if (
    evidence.current.manifest.sourceAdmission?.validationPurpose !== "publish" ||
    evidence.current.manifest.publicationAdmissionContract !== "1" ||
    !evidence.current.manifest.publicationAdmission
  ) {
    throw new Error("Publication artifacts require publish-purpose admitted qualification");
  }
  if (
    evidence.current.targetSha !== candidateSha ||
    evidence.current.runAttempt !== Number(manifest.runAttempt) ||
    evidence.current.workflowRefProof !== "candidate-owned-admission-v1" ||
    !evidence.conclusions.allRequiredSucceeded ||
    !isDeepStrictEqual(evidence.current.manifest, sortJsonValueKeys(manifest))
  ) {
    throw new Error("Publication artifact is not bound to authenticated candidate qualification");
  }
  if (!evidence.qualificationAdmission) {
    throw new Error("Authenticated candidate admission authority is missing");
  }
  // Hold the already authenticated bytes independently of caller-owned manifests.
  // This callback is process-local authority, never a serialized proof field.
  const authority = structuredClone({
    descriptor: manifest.sourceAdmission.qualificationAdmission,
    admission: evidence.qualificationAdmission,
  });
  const revalidateAuthority = () =>
    evidenceClient.revalidateQualificationAdmissionAuthority(authority);
  revalidateAuthority();
  return { ...evidence, revalidateAuthority };
}

function gitIsAncestor(ancestor, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${target}^{commit}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `Could not validate trusted workflow ancestry: ${result.stderr?.trim() || result.signal || result.status}.`,
  );
}

async function main() {
  const manifestPath = process.env.MANIFEST_FILE ?? "";
  if (!manifestPath) {
    throw new Error("MANIFEST_FILE is required.");
  }
  const run = JSON.parse(await text(process.stdin));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const trustedMainRef = process.env.TRUSTED_MAIN_REF ?? "refs/remotes/origin/main";
  const consumer = process.env.PUBLICATION_CONSUMER ?? "";
  const coreProjection = consumer === "core-npm" || consumer === "docker-only";
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
    expectedWorkflowBranch: process.env.EXPECTED_WORKFLOW_BRANCH,
    expectedCoreNpmPublication: coreProjection
      ? { npmDistTag: process.env.RELEASE_NPM_DIST_TAG ?? "" }
      : undefined,
    expectedPublicationSelection:
      consumer === "publisher"
        ? () =>
            normalizePublicationIntent(
              "publish",
              JSON.stringify({
                route: process.env.PREPARED_PLUGINS?.trim()
                  ? "prepared"
                  : process.env.RELEASE_NPM_DIST_TAG === "extended-stable"
                    ? "extended-stable"
                    : "normal",
                npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
                publishOpenclawNpm: process.env.PUBLISH_OPENCLAW_NPM === "true",
                pluginPublishScope: process.env.PLUGIN_PUBLISH_SCOPE,
                plugins: (process.env.RELEASE_PLUGINS ?? "").split(/[\s,]+/u).filter(Boolean),
                ...(process.env.WINDOWS_NODE_TAG
                  ? {
                      windowsNodeTag: process.env.WINDOWS_NODE_TAG,
                      windowsNodeInstallerDigests: JSON.parse(
                        process.env.WINDOWS_NODE_INSTALLER_DIGESTS ?? "",
                      ),
                    }
                  : {}),
              }),
            ).publicationSelection
        : undefined,
    manifestPath,
    verifierSourceSha: process.env.WORKFLOW_SHA ?? process.env.GITHUB_SHA,
    verifierSourceContent: readFileSync(
      process.env.STRICT_VALIDATOR_FILE ??
        fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url)),
    ),
    isTrustedMainAncestor: (sha) => gitIsAncestor(sha, trustedMainRef),
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
