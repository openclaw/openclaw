/** Browser-safe read model; offsets are half-open UTF-8 bytes in the exact report. */
export type ResearchObservation = {
  phase: "planning" | "gathering" | "assessing" | "auditing";
  counts: { searches: number; fetches: number; modelCalls: number; sources: number };
  sources: Array<{
    id: string;
    title: string;
    url?: string;
    text: string;
    retrievedAt: string;
    extraction: "web-fetch-text-v1" | "supplied-text-v1";
  }>;
};
export type ResearchViewSource = {
  id: string;
  title: string;
  url?: string;
  provenance: "provider-cited" | "retrieved-text" | "supplied-document";
  retrievalStatus: "not-fetched" | "retained";
  retrievedAt?: string;
  excerpt?: string;
};
export type ResearchView = {
  version: 1;
  jobId: string;
  question: string;
  title: string;
  state:
    | "queued"
    | "running"
    | "paused"
    | "submitting"
    | "indeterminate"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed";
  phase: string;
  summary: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  actions: Array<"cancel" | "resume">;
  counts?: ResearchObservation["counts"];
  sources: ResearchViewSource[];
  findings: Array<{
    statement: string;
    support: "quote-matched" | "model-supported";
    evidence: Array<{ sourceId: string; quote: string }>;
  }>;
  gaps: string[];
  limitations: string[];
  report?: string;
  citations: Array<{ sourceId: string; startByte: number; endByte: number }>;
};
export type ResearchList = {
  version: 1;
  /** Actual admitted incarnation. A client must discard snapshots from a previous one. */
  sessionId: string;
  /** Opaque sessionId + lifecycleRevision fence, including lifecycle-only replacements. */
  incarnation: string;
  jobs: Array<
    Pick<ResearchView, "jobId" | "title" | "state" | "phase" | "summary" | "createdAt" | "counts">
  >;
};
