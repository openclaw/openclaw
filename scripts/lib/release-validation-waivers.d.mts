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
export interface ReleasePolicyJob {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  html_url?: string;
}
export interface ReleaseChildPolicy {
  waivers: ReleaseValidationWaiver[];
  aggregates: { jobName: string; stepName: string; causes: string[] }[];
  waivedJobNames: Set<string>;
  blockingJobs: ReleasePolicyJob[];
  advisoryJobs: ReleasePolicyJob[];
  advisoryFailureAllowed: boolean;
}
export function isFailedReleaseJob(job: ReleasePolicyJob): boolean;
export function evaluateReleaseChildPolicy(input: {
  child: { key: string; jobs: ReleasePolicyJob[]; runId?: string; runAttempt?: number };
  targetVersion?: string;
}): ReleaseChildPolicy;
export class ReleaseAggregateValidationError extends Error {}
export function validateReleaseWaiverAggregates(input: {
  policy: ReleaseChildPolicy;
  jobs: (ReleasePolicyJob & {
    id: number;
    steps?: { name: string; conclusion: string | null }[];
  })[];
  getJobLog: (jobId: number) => unknown;
}): Promise<void>;

export function releaseChildAdvisories(child: {
  key: string;
  runId?: string;
  jobs: ReleasePolicyJob[];
}): {
  class: string;
  child: string;
  job: string;
  conclusion: string | null;
  runId: string;
  url: string;
}[];
