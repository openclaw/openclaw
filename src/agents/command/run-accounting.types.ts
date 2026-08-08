import type { CodeModeStats } from "../code-mode-stats.js";
import type { EmbeddedRunAccountingObservation } from "../embedded-agent-runner/run/accounting-observers.js";
import type { EmbeddedRunOpaqueWorkReason } from "../embedded-agent-runner/run/accounting-observers.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import type { AgentSubmissionHandle } from "../sessions/agent-session-accounting.js";

export type AgentCommandCandidateRuntime = "embedded" | "cli" | "native" | "cloud" | "unknown";

export type AgentCommandRunAccountingCoverageReason =
  | "candidate_failed"
  | "candidate_details_truncated"
  | "candidate_identity_truncated"
  | "effective_model_details_truncated"
  | "cli_runtime"
  | "native_runtime"
  | "cloud_runtime"
  | "unknown_runtime"
  | "missing_usage"
  | "partial_usage"
  | "missing_pricing"
  | "tiered_pricing_aggregate"
  | "acp_runtime"
  | "settled_finalization_failed"
  | "session_core_compaction"
  | "session_extension_compaction"
  | "context_engine_llm_complete"
  | "deferred_context_engine_maintenance"
  | "post_turn_compaction"
  | "exec_auto_review_model_completion"
  | "tool_details_truncated"
  | "not_instrumented"
  | "not_observed"
  | "attempt_extraction_only";

export type AgentCommandRunAccountingCoverage =
  | { state: "complete" }
  | {
      state: "partial" | "unavailable";
      reasons: AgentCommandRunAccountingCoverageReason[];
    };

export type AgentCommandRunCandidateAccounting = {
  selectRuntime: (runtime: Exclude<AgentCommandCandidateRuntime, "unknown">) => void;
  beginAgentSubmission: () => AgentSubmissionHandle;
  observeEmbeddedAttempt: (observation: EmbeddedRunAccountingObservation) => void;
  markOpaqueWork: (reason: EmbeddedRunOpaqueWorkReason) => void;
  settle: (outcome: "returned" | "threw") => void;
};

export type RunAccountingAccumulator = {
  beginCandidate: (identity: {
    provider: string;
    model: string;
  }) => AgentCommandRunCandidateAccounting;
  markOpaqueWork: (reason: EmbeddedRunOpaqueWorkReason) => void;
  project: () => AgentCommandRunAccountingSnapshot;
};

export type AgentCommandRunUsageBucket =
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "reasoningTokens"
  | "total";

type AgentCommandRunCandidateRecord = {
  provider: string;
  model: string;
  runtime: AgentCommandCandidateRuntime;
  outcome: "returned" | "threw";
  effectiveModels: {
    entries: Array<{ provider: string; model: string }>;
    truncated: number;
  };
};

export type AgentCommandRunAccountingSnapshot = {
  candidates: {
    total: number;
    returned: number;
    threw: number;
    runtimes: Record<AgentCommandCandidateRuntime, number>;
    entries: AgentCommandRunCandidateRecord[];
    truncated: number;
  };
  agentSubmissions?: {
    total: number;
    completed: number;
    failed: number;
  };
  assistantTurns?: number;
  usage?: Partial<Record<AgentCommandRunUsageBucket, number>>;
  toolSummary?: ToolSummaryTrace;
  toolNamesTruncated?: true;
  costUsd?: number;
  commandExecutionDurationMs: number;
  coverage: {
    candidates: AgentCommandRunAccountingCoverage;
    agentSubmissions: AgentCommandRunAccountingCoverage;
    assistantTurns: AgentCommandRunAccountingCoverage;
    usage: AgentCommandRunAccountingCoverage;
    usageBuckets: Record<AgentCommandRunUsageBucket, AgentCommandRunAccountingCoverage>;
    tools: AgentCommandRunAccountingCoverage;
    cost: AgentCommandRunAccountingCoverage;
    agentTime: AgentCommandRunAccountingCoverage;
    commandExecutionDuration: AgentCommandRunAccountingCoverage;
    wallLatency: AgentCommandRunAccountingCoverage;
    providerTransport: AgentCommandRunAccountingCoverage;
  };
  codeMode?: {
    engaged: boolean;
    stats?: CodeModeStats;
    lifecycle: {
      maxUnresolvedAtExtraction?: number;
      attemptsWithUnresolved?: number;
      finalQuiescence: AgentCommandRunAccountingCoverage;
    };
  };
};
