import type { PublicationObservation } from "./frv-publication-status.mts";

export type FrvPublicationStatus = Partial<FrvContinuationStatus> & {
  publication: PublicationObservation;
};

export interface FrvChildStatus extends Record<string, unknown> {
  effectiveRunAttempt: number | null;
  key: string;
  plannedRunAttempt: number | null;
  runId: string;
  status: "active" | "failed" | "missing" | "passed";
}

export interface FrvContinuationStatus {
  active: FrvChildStatus[];
  children: FrvChildStatus[];
  failed: FrvChildStatus[];
  missing: FrvChildStatus[];
  passed: FrvChildStatus[];
}

interface FrvReadOptions {
  operationDeadline?: number;
}

export interface FrvClient {
  repository?: string;
  getReleaseEvidenceClient: () => ReturnType<
    typeof import("./release-ci-summary.mjs").createReleaseEvidenceClient
  >;
  getAttemptJobs: (
    runId: string,
    runAttempt: number,
    options?: FrvReadOptions,
  ) => Promise<Record<string, unknown>[]>;
  getJobLog: (jobId: number, options?: FrvReadOptions) => Promise<string>;
  getParentJobs: (runId: string, options?: FrvReadOptions) => Promise<Record<string, unknown>[]>;
  getRun: (runId: string, options?: FrvReadOptions) => Promise<Record<string, unknown>>;
  getRunAttempt: (
    runId: string,
    runAttempt: number,
    options?: FrvReadOptions,
  ) => Promise<Record<string, unknown>>;
  rerunFailed?: (runId: string) => Promise<unknown>;
  rerunJob?: (jobId: number) => Promise<unknown>;
  rerunParent?: (runId: string) => Promise<unknown>;
  cancelRun?: (runId: string) => Promise<unknown>;
  rerunRun?: (runId: string) => Promise<unknown>;
  listRuns?: (query: string) => Promise<Record<string, unknown>[]>;
  getVariable?: (name: string) => Promise<string>;
  setVariable?: (name: string, value: string) => Promise<unknown>;
  deleteVariable?: (name: string) => Promise<unknown>;
  verify?: (
    runId: string,
    plan: Record<string, unknown>,
    operationDeadline?: number,
    expectedRunAttempts?: Record<string, number>,
  ) => Promise<unknown>;
  verifySeal?: (
    runId: string,
    plan: Record<string, unknown>,
    operationDeadline: number,
    expectedRunAttempts: Record<string, number>,
  ) => Promise<boolean>;
}

export type FrvConcreteClient = FrvClient &
  Required<
    Pick<
      FrvClient,
      "rerunFailed" | "rerunJob" | "rerunParent" | "listRuns" | "verify" | "verifySeal"
    >
  >;

export function prioritizeRelease(
  parentRunId: string,
  client: Partial<FrvClient>,
  options?: { dryRun?: boolean; outPath?: string },
): Promise<Record<string, unknown>>;
export function restoreReleasePriority(
  recordPath: string,
  client: Partial<FrvClient>,
  options?: { dryRun?: boolean },
): Promise<Record<string, unknown>>;
export function clearReleasePriority(
  client: Partial<FrvClient>,
  parentRunId: string,
): Promise<boolean>;
export function inspectContinuation(
  plan: Record<string, unknown>,
  client: Pick<FrvClient, "getAttemptJobs" | "getRun" | "repository">,
  options?: FrvReadOptions,
): Promise<FrvContinuationStatus>;
export function createClient(
  repository: string,
  dependencies?: Record<string, unknown>,
): FrvConcreteClient;
export function preflightContinuation(
  plan: Record<string, unknown>,
  rootRunId: string,
  client: Pick<
    FrvClient,
    "getJobLog" | "getParentJobs" | "getRunAttempt" | "getReleaseEvidenceClient" | "getRun"
  >,
  repository?: string,
  options?: FrvReadOptions,
): Promise<Record<string, unknown>>;
export function loadPlan(
  options: Record<string, unknown>,
  loadExecutionPlan?: (...args: unknown[]) => Promise<unknown>,
): Promise<Record<string, unknown>>;
export function continueFailed(
  plan: Record<string, unknown>,
  rootRunId: string,
  client: FrvClient,
  options?: Record<string, unknown>,
): Promise<{
  action: string;
  finalRunId?: string;
  reruns?: Record<string, unknown>[];
  status: FrvContinuationStatus;
}>;
