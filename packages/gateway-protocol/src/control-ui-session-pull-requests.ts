/** Session PR transport facts shared by Gateway, browser, and plugin consumers. */
type ControlUiSessionPullRequestChecks = {
  state: "pending" | "passing" | "failing";
  passed: number;
  failed: number;
  skipped: number;
  /** Queued/in-progress runs plus stale conclusions GitHub invalidated. */
  running: number;
};

export type ControlUiSessionPullRequestCheckStep = {
  number: number;
  name: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ControlUiSessionPullRequestCheck = {
  id: number;
  name: string;
  state: "failed" | "running" | "passed" | "skipped";
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  source: "actions" | "check";
  /** Absent for non-Actions checks or when Actions details could not be loaded. */
  steps?: ControlUiSessionPullRequestCheckStep[];
};

/** On-demand details bound to one session PR head, never part of background polling. */
export type ControlUiSessionPullRequestCheckDetails = {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  checks: ControlUiSessionPullRequestCheck[];
  status: "ready" | "stale" | "unavailable";
  rateLimited: boolean;
  error?: string;
  retryAfterMs?: number;
};

/** A pull request associated with the session's working branch. */
export type ControlUiSessionPullRequest = {
  number: number;
  /** Login-only to avoid browser avatar requests; absent for deleted accounts. */
  author?: { login: string };
  owner: string;
  repo: string;
  branch: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Latest check-run rollup for the head commit; absent when no checks ran. */
  checks?: ControlUiSessionPullRequestChecks;
  checksUrl?: string;
  /** Head binding for on-demand CI details; not a client-selected repository revision. */
  headSha?: string;
  /** Observed result of a recorded async merge request for this exact PR head. */
  merge?: {
    status: "pending" | "merged" | "enqueued" | "failed" | "unavailable";
    message: string;
    sha?: string;
    retryAfterMs?: number;
  };
};

/** Local Git facts stay available while GitHub quota is exhausted. */
export type ControlUiSessionBranch = {
  owner: string;
  repo: string;
  branch: string;
  /** Working-tree diff vs the merge base with the remote default branch. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Absent while the branch is unpushed or has nothing to compare. */
  createUrl?: string;
};

export type ControlUiSessionPullRequests = {
  pullRequests: ControlUiSessionPullRequest[];
  /** GitHub remote identity, independent of whether a PR or branch row exists. */
  repository?: { owner: string; repo: string };
  /** Non-default branch with a creatable PR or local changed files. */
  branch?: ControlUiSessionBranch;
  /** GitHub quota exhausted; entries may be stale until the limit resets. */
  rateLimited: boolean;
  /** A failed PR lookup may still carry independently resolved repository facts. */
  status?: "ready" | "rate-limited" | "unavailable";
};

/** Per-session pushed state; unavailable snapshots preserve prior UI state. */
export type ControlUiSessionPullRequestSnapshot = ControlUiSessionPullRequests & {
  status: NonNullable<ControlUiSessionPullRequests["status"]>;
};

/** Targeted delta event for sessions watched by one Control UI connection. */
export type ControlUiSessionPullRequestsChanged = {
  sessions: Record<string, ControlUiSessionPullRequestSnapshot>;
};
