import type { ReleaseFlakeIntent, ReleaseFlakeRecord } from "./full-release-flake-policy.mjs";
import type { ReleaseRecord } from "./full-release-validation-policy.mjs";
export interface ReleaseFlakeClient {
  getRun(runId: string): Promise<ReleaseRecord>;
  getAttempt(runId: string, attempt: number): Promise<ReleaseRecord>;
  getJobs(runId: string, attempt: number): Promise<ReleaseRecord[]>;
  getLog(jobId: number): Promise<string>;
  rerun(intent: ReleaseFlakeIntent): Promise<unknown>;
}
interface Context {
  plan: ReleaseRecord;
  parentAttempt: number;
  ownerDeadlineMs: number;
  client: ReleaseFlakeClient;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}
export function prepareReleaseFlakeRetry(
  input: Context & { childKey: string },
): Promise<ReleaseFlakeIntent | null>;
export function executeReleaseFlakeRetry(
  input: Context & { intent: ReleaseFlakeIntent; record: (record: ReleaseFlakeRecord) => void },
): Promise<ReleaseFlakeRecord>;

export function verifyReleaseFlakeRetryRecords(
  plan: ReleaseRecord,
  records: ReleaseFlakeRecord[],
  client: Pick<ReleaseFlakeClient, "getRun" | "getAttempt" | "getJobs"> & {
    getLog(jobId: number): Promise<string>;
  },
): Promise<void>;

export function verifyReleaseFlakeManualRetryAuthority(input: {
  plan: ReleaseRecord;
  childKey: string;
  client: Pick<ReleaseFlakeClient, "getRun" | "getAttempt" | "getJobs"> & {
    getLog(jobId: number): Promise<string>;
  };
}): Promise<{ outcome: "not-attempted" | "rejected" }>;
