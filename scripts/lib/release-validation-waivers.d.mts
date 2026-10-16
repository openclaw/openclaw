export type ReleaseValidationWaiver = {
  childRole: string;
  childRunId: string;
  childRunAttempt: number;
  jobName: string;
  suiteId: string;
  reason: string;
  approvedBy: string;
};

export type ReleaseValidationWaivers = {
  schema: "openclaw.release-validation-waivers/v1";
  targetVersion: string;
  candidateSha: string;
  parentRunId: string;
  parentRunAttempt: number;
  waivers: ReleaseValidationWaiver[];
};

export function parseReleaseValidationWaivers(value: unknown): ReleaseValidationWaivers | undefined;
export function formatReleaseValidationWaivers(value: unknown): string;
export function validateReleaseWaiverApproverAuthority(
  login: string,
  permission: { permission?: string; user?: { login?: string } },
): void;
export function validateLegacyReleaseTelegramWaiver(record: unknown): void;
export function validateReleaseWaiverBinding(
  declaration: ReleaseValidationWaivers,
  expected: { targetSha: unknown; targetVersion: unknown; runId: unknown; runAttempt: unknown },
): void;
export function releaseChildWaivers(
  declaration: ReleaseValidationWaivers,
  role: string,
  runId: string | number,
  runAttempt: number,
): ReleaseValidationWaiver[];
export function validateReleaseWaivedJobs(
  jobs: readonly {
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    acceptedRunAttempt?: unknown;
  }[],
  waivers: readonly ReleaseValidationWaiver[],
): void;
