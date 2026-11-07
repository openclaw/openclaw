export interface ReleaseValidationWaiver {
  targetVersion: string;
  childRole: string;
  jobName: string;
  reason: string;
}
export const RELEASE_VALIDATION_WAIVERS: ReleaseValidationWaiver[];
export interface RetrospectiveReleaseWaiver extends ReleaseValidationWaiver {
  parentRunId: string;
  parentRunAttempt: number;
  targetSha: string;
}
export const RELEASE_VALIDATION_RETROSPECTIVE_WAIVERS: RetrospectiveReleaseWaiver[];
export function retrospectiveReleaseWaivers(input: {
  runId: string;
  runAttempt: number;
  targetSha?: string;
  targetVersion?: string;
}): RetrospectiveReleaseWaiver[];
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
  child: { key: string; jobs: ReleasePolicyJob[] };
  targetVersion?: string;
  retrospectiveWaivers?: RetrospectiveReleaseWaiver[];
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
