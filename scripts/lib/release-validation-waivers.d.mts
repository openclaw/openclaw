export interface ReleaseValidationWaiver {
  targetVersion: string;
  childRole: string;
  jobName: string;
  reason: string;
}
export const RELEASE_VALIDATION_WAIVERS: ReleaseValidationWaiver[];
export interface ReleasePolicyJob {
  name: string;
  status: string;
  conclusion: string | null;
}
export interface ReleaseChildPolicy {
  waivers: ReleaseValidationWaiver[];
  aggregates: { jobName: string; stepName: string; causes: string[] }[];
  waivedJobNames: Set<string>;
  blockingJobs: ReleasePolicyJob[];
}
export function isFailedReleaseJob(job: ReleasePolicyJob): boolean;
export function evaluateReleaseChildPolicy(input: {
  child: { key: string; jobs: ReleasePolicyJob[] };
  targetVersion?: string;
}): ReleaseChildPolicy;
export function validateReleaseWaiverAggregates(input: {
  policy: ReleaseChildPolicy;
  jobs: (ReleasePolicyJob & {
    id: number;
    steps?: { name: string; conclusion: string | null }[];
  })[];
  getJobLog: (jobId: number) => unknown;
}): Promise<void>;
