export const closeMessage: string;
export interface StaleDecision {
  number: number;
  head: string | null;
  kind: "issue" | "pull-request";
  lane: string;
  action: "preserve" | "warn" | "unmark" | "close";
  reason: string;
  warning?: number;
  witness?: string;
  eligibleAt?: string;
  closeComment?: number;
  commentId?: number;
}
export function evaluateItem(
  snapshot: Record<string, unknown>,
  now?: number,
  ignoredComment?: number,
): StaleDecision;
export function selectScanSlice<T extends { number: number }>(
  items: T[],
  checkpoint: number | null,
  limit: number,
): { selected: T[]; next: number | null };
export function runStaleLifecycle(options: {
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
  includeIssues?: boolean;
  includePrs?: boolean;
  targetKind?: "auto" | "issue" | "pull-request";
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

export function policyFor(item: unknown): { lane: string; inactiveDays: number; graceDays: number };
export function noticeBody(item: unknown): string;
export function closeBody(item: unknown, warning?: number, activity?: number): string;
export function auditRecentBugClosures(
  options: unknown,
): Promise<{ inspected: number; violations: number[] }>;
