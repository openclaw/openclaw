import { isDeepStrictEqual } from "node:util";

// Reviewed release-tooling policy, loaded from P, never the candidate checkout.
// Add an exact version, child role, job name, and reason here to grant a waiver.
/** @type {import("./release-validation-waivers.mjs").ReleaseValidationWaiver[]} */
export const RELEASE_VALIDATION_WAIVERS = [
  {
    targetVersion: "2026.9.37",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    evidence: { runId: "42361846301", runAttempt: 1 },
    qualificationExemption: {
      targetSha: "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8",
      runId: 42361846301,
      runAttempt: 1,
      workflowRef: "release-ci/5ca478fb3d02-110230586240863827911794045203864",
      sourceParentRunId: "42361691019",
      sourceParentAttempt: 1,
      artifactId: 13570296857,
      artifactDigest: "sha256:3d4c6c1be8b31c2fac6dc636d4b72e5e920d5feaca80711d1f81fca6f737bfe6",
      artifactSizeBytes: 1104,
      receiptSha256: "5f52379d07a1cef385b598142889ec56514c99afc4575f1643442227bd5a53be",
    },
    reason:
      "Dallin Romney authorized the 2026.9.37 performance exception on " +
      "2026-11-07 at 17:08 UTC (FRV 42361691019/1; C/Q " +
      "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8). The retained report " +
      "kova-261107-095817-423747 has only the bundled-plugin-startup " +
      "gateway maxCpuPercent breach (483 > 360). Only this reviewed child " +
      "attempt is waived; retain its raw failure and report. Other failures, " +
      "missing evidence, and later attempts remain blocking. At 17:49 UTC " +
      "the operator additionally authorized a new candidate qualification " +
      "with performance explicitly waived-not-run. The old receipt supports " +
      "that exception only; it does not measure or qualify the new candidate.",
  },
];

// This is an explicit not-run disposition for a new C/Q, not reuse of the old
// measurement. Only P may seal it into independently authenticated coverage.
export function releaseQualificationExemptions(targetVersion, profile) {
  if (!["stable", "full"].includes(profile)) {
    return [];
  }
  return RELEASE_VALIDATION_WAIVERS.filter(
    (waiver) => waiver.targetVersion === targetVersion && waiver.qualificationExemption,
  ).map((waiver) => ({
    childRole: waiver.childRole,
    targetVersion: waiver.targetVersion,
    disposition: "waived-not-run",
    reason: waiver.reason,
    supportingEvidence: waiver.qualificationExemption,
  }));
}

export function validateQualificationExemptions(exemptions, targetVersion, profile) {
  if (!isDeepStrictEqual(exemptions, releaseQualificationExemptions(targetVersion, profile))) {
    throw new Error("Qualification exemptions differ from current release-tooling policy");
  }
}
