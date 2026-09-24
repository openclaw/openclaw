import { evaluateReleaseBootstrapGate } from "./lib/release-publish-gates.mts";

const SHA = /^[a-f0-9]{40}$/u;
const PACKAGE = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;

const WAIVER_SOURCES = new Set(["explicit", "sealed"]);

export function createStablePluginNpmBootstrapApproval(input) {
  const stableSoakWaiver = typeof input.stableSoakWaiver === "string" ? input.stableSoakWaiver : "";
  const stableSoakWaiverSource = stableSoakWaiver ? input.stableSoakWaiverSource : "";
  if (stableSoakWaiver && !WAIVER_SOURCES.has(stableSoakWaiverSource)) {
    throw new Error("Stable npm bootstrap requires the soak waiver source (explicit or sealed).");
  }
  const eligibility = evaluateReleaseBootstrapGate(input);
  if (eligibility.status === "FAIL") {
    throw new Error(eligibility.message);
  }
  if (
    input.repository !== "openclaw/openclaw" ||
    !SHA.test(input.targetSha ?? "") ||
    !SHA.test(input.parentWorkflowSha ?? "") ||
    !new RegExp(`^release-publish/${input.parentWorkflowSha.slice(0, 12)}-[1-9][0-9]*$`, "u").test(
      input.workflowBranch,
    ) ||
    input.workflowFullRef !== `refs/tags/${input.workflowBranch}` ||
    !/^[1-9][0-9]*$/u.test(input.parentRunId ?? "") ||
    !Number.isSafeInteger(input.parentRunAttempt) ||
    input.parentRunAttempt < 1 ||
    !/^[1-9][0-9]*$/u.test(input.validationRunId ?? "") ||
    !Number.isSafeInteger(input.validationRunAttempt) ||
    input.validationRunAttempt < 1
  ) {
    throw new Error(
      "Stable npm bootstrap requires an exact protected parent and validation tuple.",
    );
  }
  if (
    !Array.isArray(input.packages) ||
    input.packages.length === 0 ||
    input.packages.some((name) => typeof name !== "string" || !PACKAGE.test(name)) ||
    new Set(input.packages).size !== input.packages.length
  ) {
    throw new Error("Stable npm bootstrap requires a unique publishable @openclaw package set.");
  }
  return {
    version: 1,
    kind: "npm-stable-bootstrap",
    repository: input.repository,
    parentRunId: input.parentRunId,
    parentRunAttempt: input.parentRunAttempt,
    workflowBranch: input.workflowBranch,
    workflowFullRef: input.workflowFullRef,
    parentWorkflowSha: input.parentWorkflowSha,
    releaseTag: input.releaseTag,
    targetSha: input.targetSha,
    publishTag: input.publishTag,
    releaseProfile: input.releaseProfile,
    stableSoakWaiver,
    ...(stableSoakWaiver ? { stableSoakWaiverSource } : {}),
    validationRunId: input.validationRunId,
    validationRunAttempt: input.validationRunAttempt,
    packages: input.packages.toSorted(),
  };
}

export function validateStablePluginNpmBootstrapApproval(approval, expected) {
  const canonical = createStablePluginNpmBootstrapApproval(approval);
  if (JSON.stringify(approval) !== JSON.stringify(canonical)) {
    throw new Error("Stable npm bootstrap approval is not canonical.");
  }
  for (const key of [
    "repository",
    "parentRunId",
    "parentRunAttempt",
    "workflowBranch",
    "workflowFullRef",
    "parentWorkflowSha",
    "targetSha",
    "publishTag",
  ]) {
    if (approval[key] !== expected[key]) {
      throw new Error(`Stable npm bootstrap approval ${key} does not match this publication.`);
    }
  }
  if (
    approval.releaseTag !== `v${expected.packageVersion}` ||
    !approval.packages.includes(expected.packageName)
  ) {
    throw new Error("Stable npm bootstrap approval does not cover this package and version.");
  }
  assertStableSoakWaiverStillHeld(approval, expected.currentStableSoakWaiver ?? "");
}

/**
 * A waiver sealed from the repository variable authorizes the token-backed
 * publish only while the variable still holds the same text right now; call
 * this immediately before npm I/O as well as at approval validation.
 */
export function assertStableSoakWaiverStillHeld(approval, currentStableSoakWaiver) {
  if (
    approval.stableSoakWaiver &&
    approval.stableSoakWaiverSource === "sealed" &&
    String(currentStableSoakWaiver ?? "").trim() !== approval.stableSoakWaiver.trim()
  ) {
    throw new Error(
      "Stable npm bootstrap approval relies on a sealed soak waiver that the repository variable no longer holds.",
    );
  }
}
