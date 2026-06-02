import type { HeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type {
  SessionContextBudgetStatus,
  SessionSystemPromptReport,
} from "../../../config/sessions/types.js";
import type { ContextEngine, ContextEnginePromptCacheInfo } from "../../../context-engine/types.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage, Model } from "../../../llm/types.js";
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/hook-before-agent-start.types.js";
import type { AgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { AgentRunTimeoutPhase } from "../../run-timeout-attribution.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import type { NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunReplayMetadata, EmbeddedRunReplayState } from "../replay-state.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedAgentParams,
  "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue"
>;

/** Resolved context-window budget and provenance used by prompt assembly and diagnostics. */
export type EmbeddedRunContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: "model" | "modelsConfig" | "agentContextTokens" | "default";
};

/** Fully resolved inputs for one embedded model attempt after run-level normalization. */
export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  initialReplayState?: EmbeddedRunReplayState;
  /** Pluggable context engine for ingest/assemble/compact lifecycle. */
  contextEngine?: ContextEngine;
  /** Resolved model context window in tokens for assemble/compact budgeting. */
  contextTokenBudget?: number;
  /** Source metadata for the resolved model context budget. */
  contextWindowInfo?: EmbeddedRunContextWindowInfo;
  /** Resolved API key for this run when runtime auth did not replace it. */
  resolvedApiKey?: string;
  /** Auth profile resolved for this attempt's provider/model call. */
  authProfileId?: string;
  /** Source for the resolved auth profile (user-locked or automatic). */
  authProfileIdSource?: "auto" | "user";
  provider: string;
  modelId: string;
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** OpenClaw-owned runtime policy prepared by the orchestrator for this attempt. */
  runtimePlan?: AgentRuntimePlan;
  /** Host-issued scope for harnesses that mirror native child runs into task state. */
  agentHarnessTaskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  model: Model;
  authStorage: AuthStorage;
  /** Auth profile store already resolved during startup for this attempt. */
  authProfileStore: AuthProfileStore;
  /**
   * Full auth profile store for OpenClaw tool availability.
   * Plugin-owned harnesses may scope `authProfileStore` to model transport credentials.
   */
  toolAuthProfileStore?: AuthProfileStore;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  /** Hook result captured before attempt creation so retries reuse the same startup decisions. */
  beforeAgentStartResult?: PluginHookBeforeAgentStartResult;
  /** Number of finalize-hook revisions already consumed for this run. */
  beforeAgentFinalizeRevisionAttempts?: number;
  /** Maximum finalize-hook revision attempts allowed before returning the model result. */
  maxBeforeAgentFinalizeRevisions?: number;
};

/** Complete attempt outcome consumed by fallback, persistence, lifecycle, and harness callers. */
export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  /** True when the abort originated from the caller-provided abortSignal. */
  externalAbort: boolean;
  timedOut: boolean;
  /** True when the no-response LLM idle watchdog caused the timeout. */
  idleTimedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  /** Optional because this type is re-exported as `AgentHarnessAttemptResult`. */
  timedOutDuringToolExecution?: boolean;
  promptError: unknown;
  /**
   * Identifies which phase produced the promptError.
   * - "prompt": the LLM call itself failed and may be eligible for retry/fallback.
   * - "compaction": the prompt succeeded, but waiting for compaction/retry teardown was aborted;
   *   this must not be retried as a fresh prompt or the same tool turn can replay.
   * - "precheck": pre-prompt overflow recovery intentionally short-circuited the prompt so the
   *   outer run loop can recover via compaction/truncation before any model call is made.
   * - "hook:before_agent_run": a lifecycle hook blocked the run before the prompt was sent.
   * - null: no promptError.
   */
  promptErrorSource: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
  preflightRecovery?:
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        source?: "mid-turn";
        handled: true;
        truncatedCount?: number;
      }
    | {
        route: Exclude<PreemptiveCompactionRoute, "fits">;
        source?: "mid-turn";
        handled?: false;
      };
  sessionIdUsed: string;
  /** Transcript file used for this attempt after session routing and lock acquisition. */
  sessionFileUsed?: string;
  /** Trace context propagated into model and tool diagnostics for this attempt. */
  diagnosticTrace?: DiagnosticTraceContext;
  agentHarnessId?: string;
  /** Classification returned to harness selection for retry/fallback decisions. */
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  /** Timeout recovery payload surfaced to the outer run loop and session lifecycle. */
  promptTimeoutOutcome?: {
    message?: string;
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  };
  /** App-server transport failure metadata used to decide whether retry is replay-safe. */
  codexAppServerFailure?: {
    kind: "client_closed_before_turn_completed" | "turn_completion_idle_timeout";
    turnWatchTimeoutKind?: "progress" | "completion" | "terminal";
    transport: "stdio" | "websocket";
    threadId?: string;
    turnId?: string;
    replaySafe: boolean;
    replayBlockedReason?:
      | "assistant_output"
      | "tool_activity"
      | "potential_side_effect"
      | "active_item";
  };
  /** Once-mode bootstrap truncation warnings already surfaced in this session. */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Last bootstrap truncation warning signature persisted for UI/session state. */
  bootstrapPromptWarningSignature?: string;
  systemPromptReport?: SessionSystemPromptReport;
  /** Rendered prompt text captured for diagnostics; may be omitted for compact attempts. */
  finalPromptText?: string;
  messagesSnapshot: AgentMessage[];
  /** Finalize-hook reason that caused a revised assistant turn. */
  beforeAgentFinalizeRevisionReason?: string;
  assistantTexts: string[];
  /** Tool metadata collected during the attempt before persistence/liveness decisions. */
  toolMetas: Array<{
    toolName: string;
    meta?: string;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
  /** Accepted child sessions spawned by this attempt; used as replay side-effect evidence. */
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  lastAssistant: AssistantMessage | undefined;
  /** Assistant message emitted by this attempt before fallback may inspect prior attempts. */
  currentAttemptAssistant?: AssistantMessage | undefined;
  lastToolError?: ToolErrorSummary;
  didSendViaMessagingTool: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  /** Texts delivered through messaging tools, tracked separately from assistant prose. */
  messagingToolSentTexts: string[];
  /** Media URLs delivered through messaging tools for replay and incomplete-turn checks. */
  messagingToolSentMediaUrls: string[];
  /** Full messaging send records, including target identity for committed delivery checks. */
  messagingToolSentTargets: MessagingToolSend[];
  /** Source-reply payloads emitted by tools for channel-specific response handling. */
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  /** Media URLs produced by tools and forwarded into reply payloads. */
  toolMediaUrls?: string[];
  /** Whether tool audio should be delivered through voice-capable reply paths. */
  toolAudioAsVoice?: boolean;
  /** Whether produced media came from trusted local paths rather than untrusted remote fetches. */
  toolTrustedLocalMedia?: boolean;
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  promptCache?: ContextEnginePromptCacheInfo;
  contextBudgetStatus?: SessionContextBudgetStatus;
  compactionCount?: number;
  compactionTokensAfter?: number;
  /**
   * Client tool calls detected during this attempt (OpenResponses hosted
   * tools), in the order the underlying LLM emitted them. Field is
   * `undefined` when no client tools were called so existing truthiness
   * checks across the runner pipeline (`attempt.clientToolCalls ? ...`)
   * keep their meaning. When set, the array always has at least one entry.
   */
  clientToolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  /** True when sessions_yield tool was called during this attempt. */
  yieldDetected?: boolean;
  replayMetadata: EmbeddedRunReplayMetadata;
  /** Provider item lifecycle counters used to avoid replaying while work is still active. */
  itemLifecycle: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
  /** Late lifecycle metadata setter; outer callers wire this to durable run state. */
  setTerminalLifecycleMeta?: (meta: {
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    stopReason?: string;
    yielded?: boolean;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
  }) => void;
};
