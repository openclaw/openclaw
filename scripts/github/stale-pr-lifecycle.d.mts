export const closeMessage: string;
export interface StaleDecision {
  number: number;
  head: string;
  action: "preserve" | "warn" | "unmark" | "close";
  reason: string;
  warning?: number;
  witness?: string;
  eligibleAt?: string;
  closeComment?: number;
  commentId?: number;
}
export function evaluatePullRequest(
  snapshot: Record<string, unknown>,
  now?: number,
  ignoredComment?: number,
): StaleDecision;
export function selectScanSlice<T extends { number: number }>(
  items: T[],
  checkpoint: number | null,
  limit: number,
): { selected: T[]; next: number | null };
export function runStalePullRequests(options: {
  github: unknown;
  checksGithub: unknown;
  mutationGithub?: unknown;
  expectedAppId?: number;
  context: { repo: { owner: string; repo: string } };
  core?: unknown;
  dryRun?: boolean;
  targets?: number[];
  maxClosures?: number;
  detailLimit?: number;
  cursorPath?: string;
  now?: () => number;
}): Promise<{
  decisions: StaleDecision[];
  closed: number;
  remainingClosures: number;
  next: number | null;
  requests: number;
  metadataRequests: number;
  considered: number;
  exhausted: boolean;
  unfinished: boolean;
}>;
