/** Runtime result data shared by execution producers and completion consumers. */
import type { ProviderRefusalReview } from "@openclaw/llm-core/diagnostics";
import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { AgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import type {
  CliSessionBinding,
  SessionContextBudgetStatus,
  SessionSystemPromptReport,
} from "../../config/sessions/types.js";
import type { AgentRunTerminalReceipt } from "../agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "../agent-run-terminal-reply.types.js";
import type { FallbackAttempt } from "../model-fallback.types.js";
import type { ReplyExpectation } from "../reply-completion.js";
import type { AgentRuntimeCredentialSource } from "../runtime-plan/credential-source.types.js";
import type { NormalizedUsage } from "../usage.js";

export type EmbeddedAgentMeta = {
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  contextTokens?: number;
  contextTokensSource?: "runtime" | "runtime-configured" | "resolved" | "resolved-v1";
  agentHarnessId?: string;
  /** Sanitized provider-policy refusal attached to this physical attempt. */
  providerRefusal?: {
    provider?: string;
    category?: string;
    review?: ProviderRefusalReview;
    /** Physical request facts used only to retry the same model and account. */
    accessProgram?: "standard" | "daybreak_blue" | "daybreak_red";
    authProfileId?: string;
    nativeThreadId?: string;
    nativeTurnId?: string;
  };
  /** Runtime-owned selection, independent of the final response or credential source. */
  runtimeModelSelection?: ProviderModelRef;
  /** Redacted credential source selected for the terminal physical model attempt. */
  credentialSource?: AgentRuntimeCredentialSource;
  fallbackAttempts?: FallbackAttempt[];
  cliSessionBinding?: CliSessionBinding;
  clearCliSessionBinding?: boolean;
  compactionCount?: number;
  /**
   * Token count estimate after the most recent successful auto-compaction.
   * Used as the freshest context snapshot when the follow-up model call omits
   * usage metadata.
   */
  compactionTokensAfter?: number;
  /**
   * Prompt/context snapshot from the latest model request. Prefer this for
   * context-window utilization because provider usage totals can include cached
   * and completion tokens that are useful for billing but noisy as live context.
   */
  promptTokens?: number;
  /** Billing totals may span candidates; unavailable context prevents treating them as a snapshot. */
  usage?: NormalizedUsage;
  /** Terminal cumulative usage for turn-level diagnostics and persisted CLI transcript accounting. */
  diagnosticUsage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated across tool-use
   * loops or compaction retries). Used for context-window utilization display
   * (`totalTokens` in sessions.json) because the accumulated `usage.input`
   * sums input tokens from every API call in the run, which overstates the
   * actual context size.
   */
  lastCallUsage?: NormalizedUsage;
  contextBudgetStatus?: SessionContextBudgetStatus;
  /**
   * True when code mode owned the model tool surface for this run. Config
   * alone is not proof: the "auto" tier engages per model capability, raw
   * model runs and plugin-harness surfaces can decline engagement, and the
   * shell tool is also named `exec`, so consumers must read this flag
   * instead of config or tool names.
   */
  codeModeEngaged?: boolean;
  /** Completed assistant/provider round trips accumulated across run attempts. */
  assistantTurns?: number;
  /**
   * Code-mode/tool-search inner bridge calls for the run's catalog. These are
   * invisible to the provider; `toolSummary.calls` stays the outer count.
   */
  bridgeCalls?: {
    search: number;
    describe: number;
    call: number;
  };
  /** Estimated USD cost of the run's accumulated usage. Omitted when the model has no cost data. */
  costUsd?: number;
  terminalReceipt?: Omit<AgentRunTerminalReceipt, "terminalDisposition">;
};

export type TraceAttempt = {
  provider: string;
  model: string;
  result:
    | "success"
    | "timeout"
    | "surface_error"
    | "candidate_failed"
    | "rotate_profile"
    | "same_model_transient"
    | "fallback_model"
    | "aborted"
    | "error";
  reason?: string;
  stage?: "prompt" | "assistant";
  elapsedMs?: number;
  status?: number;
};

export type ToolSummaryTrace = {
  calls: number;
  tools: string[];
  failures?: number;
  /** Latest tool failure not cleared by same-tool success, independent of reply presentation. */
  unresolvedError?: { toolName: string };
  totalToolTimeMs?: number;
};

export type EmbeddedRunLivenessState = "working" | "paused" | "blocked" | "abandoned";

export type EmbeddedRunFailureSignal = {
  kind: "execution_denied";
  source: "tool";
  toolName?: string;
  code: "SYSTEM_RUN_DENIED" | "INVALID_REQUEST";
  message: string;
  fatalForCron: true;
};

export type EmbeddedRunTerminalToolFailure = {
  source: "tool";
  toolName: "exec" | "wait";
  code: "UNKNOWN_TOOL_ID";
};

export type EmbeddedAgentRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedAgentMeta;
  aborted?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  finalPromptText?: string;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  /**
   * Raw text of only the model's own latest message; "" when that message had
   * no final text (empty, or it ended in a tool call). finalAssistantRawText can
   * be cumulative (CLI) or runner-substituted earlier text, so diagnostics prefer
   * this field. Unset when the runtime exposes no message (assistantTexts only).
   */
  finalAssistantMessageRawText?: string;
  replayInvalid?: boolean;
  livenessState?: EmbeddedRunLivenessState;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  /** Producer-owned terminal cause; the fallback owner decides whether a chain was stopped. */
  modelFallbackStopReason?:
    | "agent_run_terminal_timeout"
    | "idle_timeout_circuit_breaker"
    | "provider_review_continuation";
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  /** An exact, successfully settled tool batch intentionally completed the turn without a reply. */
  intentionalTerminalCompletion?: "tool-batch";
  terminalReply?: AgentRunTerminalReplySnapshot;
  terminalReplyExpectation?: ReplyExpectation;
  /** Retain a failed internal result without a user-facing retry notice. */
  suppressErrorNotice?: boolean;
  yielded?: boolean;
  /** Explicit user-facing waiting status supplied to sessions_yield. */
  yieldAcknowledgment?: string;
  /**
   * A visible parent delegated its otherwise-empty result to completion children
   * or a detached media run.
   */
  continuationPending?: true;
  error?: {
    kind:
      | "context_overflow"
      | "compaction_failure"
      | "compaction_replay_refresh_required"
      | "role_ordering"
      | "image_size"
      | "retry_limit"
      | "incomplete_turn"
      | "hook_block";
    message: string;
    /** True only when model fallback can retry this terminal error without repeating side effects. */
    fallbackSafe?: boolean;
    /** True when the payload includes a trusted structured terminal tool summary. */
    terminalPresentation?: boolean;
  };
  failureSignal?: EmbeddedRunFailureSignal;
  /** Bounded, sanitized unresolved Code Mode failure for operator diagnostics. */
  terminalToolFailure?: EmbeddedRunTerminalToolFailure;
  /** Stop reason for the agent run (e.g., "completed", "tool_calls"). */
  stopReason?: string;
  /** Pending tool calls when stopReason is "tool_calls". */
  pendingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  executionTrace?: {
    winnerProvider?: string;
    winnerModel?: string;
    attempts?: TraceAttempt[];
    fallbackUsed?: boolean;
    runner?: "embedded" | "cli";
    providerPolicyRetry?: {
      category: "cyber";
      provider: string;
      model: string;
    };
  };
  requestShaping?: {
    authMode?: string;
    thinking?: string;
    thinkingClamp?: string;
    reasoning?: string;
    verbose?: string;
    trace?: string;
    fallbackEligible?: boolean;
    blockStreaming?: string;
  };
  promptSegments?: {
    key: string;
    chars: number;
  }[];
  toolSummary?: ToolSummaryTrace;
  completion?: {
    finishReason?: string;
    stopReason?: string;
    refusal?: boolean;
  };
  contextManagement?: {
    sessionCompactions?: number;
    lastTurnCompactions?: number;
    preflightCompactionApplied?: boolean;
    postCompactionContextInjected?: boolean;
  };
};

export type EmbeddedAgentRunPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isStatusNotice?: boolean;
  isReasoning?: boolean;
  /** Marks pre-tool commentary (💬) — a display lane, suppressed unless the channel opts in. */
  isCommentary?: boolean;
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
  channelData?: Record<string, unknown>;
};
