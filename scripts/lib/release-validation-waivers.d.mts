export interface QualificationExemptionEvidence {
  targetSha: string;
  runId: number;
  runAttempt: number;
  workflowRef: string;
  sourceParentRunId: string;
  sourceParentAttempt: number;
  artifactId: number;
  artifactDigest: string;
  artifactSizeBytes: number;
  receiptSha256: string;
}
export interface QualificationExemption {
  childRole: string;
  targetVersion: string;
  disposition: "waived-not-run";
  reason: string;
  supportingEvidence: QualificationExemptionEvidence;
}
export function releaseQualificationExemptions(
  targetVersion: string,
  profile: string,
): QualificationExemption[];
export function validateQualificationExemptions(
  exemptions: unknown,
  targetVersion: string,
  profile: string,
): void;
export interface ReleaseValidationWaiver {
  targetVersion: string;
  childRole: string;
  jobName: string;
  reason: string;
  evidence?: { runId: string; runAttempt: number };
  qualificationExemption?: QualificationExemptionEvidence;
}
export const RELEASE_VALIDATION_WAIVERS: ReleaseValidationWaiver[];
