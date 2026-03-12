import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  compactionCount?: number;
  promptTokens?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /**
   * Usage from the last individual API call (not accumulated across tool-use
   * loops or compaction retries). Used for context-window utilization display
   * (`totalTokens` in sessions.json) because the accumulated `usage.input`
   * sums input tokens from every API call in the run, which overstates the
   * actual context size.
   */
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiPlanSearchCandidateMeta = {
  id: string;
  title: string;
  strategy: string;
  score: number;
  performanceGain: number;
  computeCost: number;
  estimatedTokens: number;
  estimatedRuntimeMs: number;
  estimatedCostUsd: number;
  withinBudget: boolean;
  budgetViolations: Array<"tokens" | "runtime_ms" | "cost_usd">;
  rationale: string[];
  stepCount: number;
};

export type EmbeddedPiPlanSearchBudgetMeta = {
  maxTokens?: number;
  maxRuntimeMs?: number;
  maxCostUsd?: number;
  withinBudgetCount: number;
  overBudgetCount: number;
};

export type EmbeddedPiPlanSearchMeta = {
  enabled: boolean;
  candidateCount: number;
  configuredScoringMode: "heuristic" | "llm";
  appliedScoringMode: "heuristic" | "llm";
  objective: "performance_gain / compute_cost";
  selectedCandidateId: string;
  selectedScore: number;
  selectedPerformanceGain: number;
  selectedComputeCost: number;
  selectedWithinBudget: boolean;
  promptIncludesSelectedPlan: boolean;
  budget: EmbeddedPiPlanSearchBudgetMeta;
  considered: EmbeddedPiPlanSearchCandidateMeta[];
  scoringFailed?: boolean;
  scoringError?: string;
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  planSearch?: EmbeddedPiPlanSearchMeta;
  error?: {
    kind:
      | "context_overflow"
      | "compaction_failure"
      | "role_ordering"
      | "image_size"
      | "retry_limit";
    message: string;
  };
  /** Stop reason for the agent run (e.g., "completed", "tool_calls"). */
  stopReason?: string;
  /** Pending tool calls when stopReason is "tool_calls". */
  pendingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
  meta: EmbeddedPiRunMeta;
  // True if a messaging tool (telegram, whatsapp, discord, slack, sessions_send)
  // successfully sent a message. Used to suppress agent's confirmation text.
  didSendViaMessagingTool?: boolean;
  // True when the agent emitted a deterministic approval prompt instead of a normal reply.
  didSendDeterministicApprovalPrompt?: boolean;
  // Texts successfully sent via messaging tools during the run.
  messagingToolSentTexts?: string[];
  // Media URLs successfully sent via messaging tools during the run.
  messagingToolSentMediaUrls?: string[];
  // Messaging tool targets that successfully sent a message during the run.
  messagingToolSentTargets?: MessagingToolSend[];
  // Count of successful cron.add tool calls in this run.
  successfulCronAdds?: number;
};

export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  containerWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserBridgeUrl?: string;
  browserNoVncUrl?: string;
  hostBrowserAllowed?: boolean;
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
  };
};
