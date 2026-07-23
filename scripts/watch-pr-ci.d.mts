export interface WatchPrCiArgs {
  pr: number;
  headSha: string;
  repo: string;
  after?: number;
  attachTimeout: number;
  timeout: number;
  interval: number;
}

export interface RollupCheck {
  kind: "CheckRun" | "StatusContext";
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

export interface RollupPayload {
  state?: string;
  contexts?: { totalCount?: number; nodes?: RollupCheck[] };
}

export interface RollupClassification {
  verdict: "GREEN" | "FAILING" | "PENDING" | "STALE-CANCELLED";
  pendingCount: number;
  failingNames: string[];
}

export interface RunListItem {
  databaseId: number;
  createdAt: string;
}

export interface RunStatus {
  status?: string;
  conclusion?: string | null;
}

export interface RunAttachmentClassification {
  attach: boolean;
  warning?: string;
}

export interface PollUntilDeadlineOptions<T> {
  deadline: number;
  interval: number;
  poll: () => T | undefined | Promise<T | undefined>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export function parseArgs(argv: string[]): WatchPrCiArgs;
export function sanitizeCheckName(name: string): string;
export function classifyRollup(rollup: RollupPayload | null | undefined): RollupClassification;
export function buildFindRunArgs(repo: string, sha: string): string[];
export function selectRunAfter(runs: RunListItem[], after?: number): RunListItem | undefined;
export function classifyRunAttachment(
  runId: number,
  run: RunStatus,
  after?: number,
): RunAttachmentClassification;
export function pollUntilDeadline<T>(options: PollUntilDeadlineOptions<T>): Promise<T | undefined>;
