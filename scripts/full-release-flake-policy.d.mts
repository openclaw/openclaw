import type { ReleaseRecord } from "./full-release-validation-policy.mjs";
export interface ReleaseFlakeIntent {
  version: 1;
  parentRunId: string;
  executionPlanSha256: string;
  child: string;
  runId: string;
  sourceRunAttempt: 1;
  expectedRunAttempt: 2;
  mode: "job" | "failed";
  jobs: Array<{ id: string; name: string; conclusion: string }>;
}
export interface ReleaseFlakeRecord {
  child: string;
  executionPlanSha256: string;
  intent: ReleaseFlakeIntent | null;
  outcome: "not-attempted" | "observed" | "unknown" | "rejected";
  replacements: Array<{ id: string; name: string; runAttempt: 2 }>;
}
export function normalizeKnownFlakyJobs(value?: unknown, children?: ReleaseRecord[]): string[];
export function releaseFlakeIntentSha256(intent: ReleaseFlakeIntent): string;
export function validateReleaseFlakeIntent(
  intent: unknown,
  plan: ReleaseRecord,
): ReleaseFlakeIntent;
export function selectReleaseFlakeIntent(
  plan: ReleaseRecord,
  child: ReleaseRecord,
  run: ReleaseRecord,
  jobs: ReleaseRecord[],
): ReleaseFlakeIntent | null;
export function validateReleaseFlakeRecords(
  records: unknown,
  plan: ReleaseRecord,
  children?: Record<string, ReleaseRecord>,
): ReleaseFlakeRecord[];
