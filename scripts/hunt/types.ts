export type HuntLane = "prod-observe" | "staging-chaos";

export type HuntCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface HuntCheckResult {
  id: string;
  title: string;
  status: HuntCheckStatus;
  command?: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  evidence?: string[];
  artifacts?: string[];
  metadata?: Record<string, unknown>;
}

export interface SignatureCounts {
  name: string;
  source: string;
  countWindow: number;
  countTotal: number;
  windowMinutes: number;
  baselineWindowCount?: number;
  delta?: number;
  issueUrl?: string;
}

export type HuntClassificationCategory = "core" | "plugin-private" | "ops";

export type HuntClassificationSeverity = "p0" | "p1" | "p2";

export type HuntClassificationStatus = "new" | "known" | "regressed" | "resolved";

export interface HuntClassification {
  id: string;
  category: HuntClassificationCategory;
  severity: HuntClassificationSeverity;
  status: HuntClassificationStatus;
  summary: string;
  reproSteps?: string[];
  expected?: string;
  actual?: string;
  affectedVersions?: string[];
  suggestedFix?: string;
  issueUrl?: string;
  prUrl?: string;
}

export interface HuntReportV1 {
  version: "1";
  release: string;
  runId: string;
  lane: HuntLane;
  startedAt: string;
  endedAt: string;
  checks: HuntCheckResult[];
  signatures: SignatureCounts[];
  classification: HuntClassification[];
  upstreamLinks: string[];
  metadata?: Record<string, unknown>;
}
