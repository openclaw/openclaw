export type CompletionWorkerOutput = {
  /** Internal producer of this completion truth envelope. */
  source: string;
  /** Producer-specific completion status. */
  status: string;
  [key: string]: unknown;
};

export type CompletionTruthSource =
  | "toolResult"
  | "transcriptResult"
  | "verificationArtifact"
  | "realtimeHint"
  | "none";

export interface CompletionTruthCandidates<T = CompletionWorkerOutput> {
  toolResult?: T;
  transcriptResult?: T;
  verificationArtifact?: {
    packet?: T;
    code?: string;
  };
  realtimeHint?: T;
}

export interface CompletionTruthResolution<T = CompletionWorkerOutput> {
  kind: "resolved" | "none";
  source: CompletionTruthSource;
  confidence: "high" | "medium" | "low" | "none";
  result?: T;
  notes?: string[];
}

export interface CompletionTruthSelection {
  source: CompletionTruthSource;
  confidence: CompletionTruthResolution["confidence"];
  notes?: string[];
}

export interface ResolvedCompletionTruth<T = CompletionWorkerOutput> {
  output: T;
  selection: CompletionTruthSelection;
}
