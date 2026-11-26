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
  waivers?: ReleaseValidationWaiver[],
): QualificationExemption[];
export function validateQualificationExemptions(
  exemptions: unknown,
  targetVersion: string,
  profile: string,
  waivers?: ReleaseValidationWaiver[],
): void;
export interface ReleaseValidationWaiver {
  targetVersion: string;
  targetSha?: string;
  childRole: string;
  jobName?: string;
  reason: string;
  step?: string;
  qualificationExemption?: QualificationExemptionEvidence;
}
export interface ReleasePolicyJob {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  html_url?: string;
  firstIncompleteStep?: string;
  steps?: { name: string; conclusion: string | null; status?: string }[];
}
export interface ReleaseChildPolicy {
  waivers: ReleaseValidationWaiver[];
  workflowWaived: boolean;
  waivedWorkDidNotPass: boolean;
  waivedJobNames: Set<string>;
  missingRequiredJobs: string[];
  blockingJobs: ReleasePolicyJob[];
  advisoryJobs: ReleasePolicyJob[];
  advisoryFailureAllowed: boolean;
}
export function isFailedReleaseJob(job: ReleasePolicyJob): boolean;
export function evaluateReleaseChildPolicy(input: {
  child: {
    key: string;
    jobs: ReleasePolicyJob[];
    runId?: string;
    runAttempt?: number | null;
    status?: string;
  };
  requiredJobs?: string[];
  targetVersion?: string;
  targetSha?: string;
  waiverPolicy?: ReleaseValidationWaiver[];
}): ReleaseChildPolicy;
export const RELEASE_VALIDATION_WAIVERS_PATH: string;
export function parseReleaseValidationWaivers(source: string): ReleaseValidationWaiver[];
export function validateAuthoredReleaseWaivers(
  previous: ReleaseValidationWaiver[],
  proposed: ReleaseValidationWaiver[],
): void;
export function firstIncompleteReleaseStep(steps?: ReleasePolicyJob["steps"]): string | undefined;
export function isWaived(
  scope: {
    targetVersion?: string;
    targetSha?: string;
    childRole: string;
    jobName?: string;
    job?: ReleasePolicyJob;
  },
  waivers?: ReleaseValidationWaiver[],
): boolean;
export function decodeReleaseValidationSource(payload: unknown, sourcePath: string): string;
export function readReleaseValidationWaivers(
  readSource: (path: string) => string,
): ReleaseValidationWaiver[];
export function readReleaseValidationWaiversAsync(
  readSource: (path: string) => string | Promise<string>,
): Promise<ReleaseValidationWaiver[]>;

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
