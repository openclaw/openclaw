export type FlakeClassification = {
  schema: "openclaw.frv-flake-classification.v1";
  parentRunId: string;
  parentRunAttempt: number;
  child: "normalCi";
  childRunId: string;
  childRunAttempt: number;
  targetSha: string;
  jobId: string;
  jobName: string;
  jobUrl: string;
  conclusion: "failure" | "timed_out";
  trackingUrl: string;
  reason: string;
  classifiedBy: string;
  receiptRunId: string;
  receiptRunAttempt: number;
};
export type FlakeJob = {
  name: string;
  status: string;
  conclusion: string;
  id?: number | string;
  html_url?: string;
  url?: string;
  acceptedRunAttempt?: number;
  run_attempt?: number;
};
export type FlakeChild = { key: string; runId: string; jobs: FlakeJob[] };
export type FlakeBinding = {
  child?: FlakeChild;
  parentRunId?: string;
  parentRunAttempt?: number;
  targetSha?: string;
};
export type FlakeGateEntry = { name: string; result: string; selected: boolean | string };
export type FlakeEvidence = {
  flakeClassifications?: FlakeClassification[];
  gateEntries?: FlakeGateEntry[];
};
export type FlakeApi = (
  path: string,
  options?: { format?: "json" | "text" | "bytes"; maxBytes?: number; signal?: AbortSignal },
) => Promise<unknown>;
export const RECORDED_FLAKE_DENIED_JOB_PATTERNS: readonly RegExp[];
export function isClassifiableFlakeJob(name: unknown): boolean;
export function validateFlakeClassification(
  receipt: unknown,
  expected?: FlakeBinding,
): FlakeClassification;
export function parseFlakeGateEntries(log: string): FlakeGateEntry[];
export function validateFlakeGateEntries(entries: unknown): FlakeGateEntry[];
export function recordFlakeClassification(options: {
  inputs: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  api?: FlakeApi;
}): Promise<FlakeClassification>;
export function loadFlakeClassifications(
  options: FlakeBinding & {
    repo?: string;
    child: FlakeChild;
    parentRunId: string;
    parentRunAttempt: number;
    targetSha: string;
    api?: FlakeApi;
    signal?: AbortSignal;
  },
): Promise<FlakeEvidence>;
