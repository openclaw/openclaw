export const RELEASE_PRIORITY_VARIABLE: "OPENCLAW_RELEASE_PRIORITY_RUN";
export const RELEASE_PRIORITY_RECORD_KIND: string;
export interface ReleasePriorityRun {
  event: string;
  headBranch: string;
  id: string;
  name: string;
  url: string;
}
export interface ReleasePriorityRecord {
  cancelled: ReleasePriorityRun[];
  kind: string;
  parentRunId: string;
  recordedAt: string;
  repository?: string;
}
export function isReleaseBranch(name: unknown): boolean;
export function describeRun(run: Record<string, unknown>): ReleasePriorityRun;
export function selectQueuedRunsToCancel(
  runs: Record<string, unknown>[],
  parentRunId: string | number,
): ReleasePriorityRun[];
export function selectDeferredRunCandidates(
  runs: Record<string, unknown>[],
  record: Pick<ReleasePriorityRecord, "parentRunId" | "recordedAt">,
): Record<string, unknown>[];
export function isDeferredCiJobSet(jobs: Record<string, unknown>[]): boolean;
export function defaultReleasePriorityRecordPath(parentRunId: string | number): string;
export function writeReleasePriorityRecord(path: string, record: ReleasePriorityRecord): void;
export function readReleasePriorityRecord(path: string): ReleasePriorityRecord;
export function readReleasePriorityRecord(
  path: string,
  options: { optional: true },
): ReleasePriorityRecord | null;
export function selectLatestRunsPerLane(runs: ReleasePriorityRun[]): ReleasePriorityRun[];
export function mergeReleasePriorityRecord(
  previous: ReleasePriorityRecord | null,
  next: ReleasePriorityRecord,
): ReleasePriorityRecord;
export function isQueuedRun(run: Record<string, unknown> | undefined): boolean;
