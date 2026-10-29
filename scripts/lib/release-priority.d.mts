export const RELEASE_PRIORITY_VARIABLE: "OPENCLAW_RELEASE_PRIORITY_RUN";
export interface ReleasePriorityRun {
  event: string;
  headBranch: string;
  id: string;
  lane: string;
  name: string;
  url: string;
}
export interface ReleasePriorityRecord {
  cancelled: Array<Omit<ReleasePriorityRun, "lane"> & Partial<Pick<ReleasePriorityRun, "lane">>>;
  kind: string;
  parentRunId: string;
  recordedAt: string;
  repository?: string;
}
export function isDeferrableRun(
  run: Record<string, unknown> | undefined,
  parentRunId: string | number,
): boolean;
export function listReleasePriorityRuns(
  query: string,
  apiJson: (resource: string) => Promise<unknown>,
  apiText: (resource: string, jq: string) => Promise<string>,
): Promise<Record<string, unknown>[]>;
export function describeRun(run: Record<string, unknown>): ReleasePriorityRun;
export function selectDeferredRunCandidates(
  runs: Record<string, unknown>[],
  record: Pick<ReleasePriorityRecord, "parentRunId" | "recordedAt">,
): Record<string, unknown>[];
export function isDeferredCiJobSet(jobs: Record<string, unknown>[]): boolean;
export function readReleasePriorityRecord(path: string): ReleasePriorityRecord;
export function selectLatestRunsPerLane(runs: ReleasePriorityRun[]): ReleasePriorityRun[];
