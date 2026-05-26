import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { M as SessionScope } from "./types.base-DS--yneR.js";
import { H as SafeBinProfileFixture } from "./types.tools-BpgZArJS.js";
import { n as ReasoningLevel, o as VerboseLevel, r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { K as PromptImageOrderEntry, a as SourceReplyDeliveryMode, r as PartialReplyPayload, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as InboundEventKind, t as InputProvenance } from "./input-provenance-DgsxhTbk.js";
import { t as CommandQueueEnqueueFn } from "./command-queue.types-CfUiTJN8.js";
import { g as ExecAsk, v as ExecSecurity, y as ExecTarget } from "./exec-approvals-DZ3KhICc.js";
import { r as SandboxBackendExecSpec } from "./backend-handle.types-D7afWmft.js";
import { c as SessionSystemPromptReport, n as CliSessionBinding } from "./types-ChLEnNVH.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-DcbwO2-o.js";
import { t as FallbackAttempt } from "./model-fallback.types-B2o5-mGE.js";
import { n as SkillSnapshot } from "./skills-BRkHvK1T.js";
import { t as EmbeddedAgentExecutionPhase } from "./execution-phase-XS842OIx.js";
import { ImageContent } from "@earendil-works/pi-ai";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/auto-reply/reply/reply-run-registry.d.ts
type ReplyRunKey = string;
type ReplyBackendKind = "embedded" | "cli";
type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";
type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  cancel(reason?: ReplyBackendCancelReason): void;
  isStreaming(): boolean;
  queueMessage?: (text: string) => Promise<void>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};
type ReplyOperationPhase = "queued" | "preflight_compacting" | "memory_flushing" | "running" | "completed" | "failed" | "aborted";
type ReplyOperationFailureCode = "gateway_draining" | "command_lane_cleared" | "aborted_by_user" | "session_corruption_reset" | "run_failed";
type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";
type ReplyOperationResult = {
  kind: "completed";
} | {
  kind: "failed";
  code: ReplyOperationFailureCode;
  cause?: unknown;
} | {
  kind: "aborted";
  code: ReplyOperationAbortCode;
};
type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  complete(): void;
  /**
   * Complete the operation, clear active-run state, then run follow-up work.
   * Use when the follow-up can create another ReplyOperation for this session.
   */
  completeThen(afterClear: () => void): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
  abortForRestart(): void;
};
//#endregion
//#region src/infra/event-session-routing.d.ts
type EventSessionRoutingPolicy = {
  mainKey?: string;
  sessionScope?: SessionScope;
  dmScope?: string | null;
  allowFrom?: ReadonlyArray<string | number> | null;
  channel?: string | null;
  accountId?: string | null;
  preserveSessionKey?: boolean;
};
//#endregion
//#region src/agents/bash-tools.shared.d.ts
type BashSandboxConfig = {
  containerName: string;
  workspaceDir: string;
  containerWorkdir: string;
  env?: Record<string, string>;
  buildExecSpec?: (params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }) => Promise<SandboxBackendExecSpec>;
  finalizeExec?: (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }) => Promise<void>;
};
//#endregion
//#region src/auto-reply/heartbeat-tool-response.d.ts
declare const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
declare const HEARTBEAT_TOOL_OUTCOMES: readonly ["no_change", "progress", "done", "blocked", "needs_attention"];
type HeartbeatToolOutcome = (typeof HEARTBEAT_TOOL_OUTCOMES)[number];
declare const HEARTBEAT_TOOL_PRIORITIES: readonly ["low", "normal", "high"];
type HeartbeatToolPriority = (typeof HEARTBEAT_TOOL_PRIORITIES)[number];
type HeartbeatToolResponse = {
  outcome: HeartbeatToolOutcome;
  notify: boolean;
  summary: string;
  notificationText?: string;
  reason?: string;
  priority?: HeartbeatToolPriority;
  nextCheck?: string;
};
declare function normalizeHeartbeatToolResponse(value: unknown): HeartbeatToolResponse | undefined;
//#endregion
//#region src/agents/accepted-session-spawn.d.ts
type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
};
//#endregion
//#region src/agents/pi-embedded-messaging.types.d.ts
type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
};
type MessagingToolSourceReplyPayload = Pick<ReplyPayload, "audioAsVoice" | "channelData" | "interactive" | "mediaUrl" | "mediaUrls" | "presentation" | "text"> & {
  idempotencyKey?: string;
};
//#endregion
//#region src/agents/run-timeout-attribution.d.ts
declare const AGENT_RUN_TIMEOUT_PHASES: readonly ["queue", "preflight", "provider", "post_turn", "gateway_draining"];
type AgentRunTimeoutPhase = (typeof AGENT_RUN_TIMEOUT_PHASES)[number];
//#endregion
//#region src/agents/pi-embedded-runner/types.d.ts
type EmbeddedPiAgentMeta = {
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  contextTokens?: number;
  agentHarnessId?: string;
  fallbackAttempts?: FallbackAttempt[];
  cliSessionBinding?: CliSessionBinding;
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
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
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
    reasoningTokens?: number;
    total?: number;
  };
};
type TraceAttempt = {
  provider: string;
  model: string;
  result: "success" | "timeout" | "surface_error" | "candidate_failed" | "rotate_profile" | "fallback_model" | "aborted" | "error";
  reason?: string;
  stage?: "prompt" | "assistant";
  elapsedMs?: number;
  status?: number;
};
type ExecutionTrace = {
  winnerProvider?: string;
  winnerModel?: string;
  attempts?: TraceAttempt[];
  fallbackUsed?: boolean;
  runner?: "embedded" | "cli";
};
type RequestShapingTrace = {
  authMode?: string;
  thinking?: string;
  reasoning?: string;
  verbose?: string;
  trace?: string;
  fallbackEligible?: boolean;
  blockStreaming?: string;
};
type PromptSegmentTrace = {
  key: string;
  chars: number;
};
type ToolSummaryTrace = {
  calls: number;
  tools: string[];
  failures?: number;
  totalToolTimeMs?: number;
};
type CompletionTrace = {
  finishReason?: string;
  stopReason?: string;
  refusal?: boolean;
};
type ContextManagementTrace = {
  sessionCompactions?: number;
  lastTurnCompactions?: number;
  preflightCompactionApplied?: boolean;
  postCompactionContextInjected?: boolean;
};
type EmbeddedRunLivenessState = "working" | "paused" | "blocked" | "abandoned";
type EmbeddedRunFailureSignal = {
  kind: "execution_denied";
  source: "tool";
  toolName?: string;
  code: "SYSTEM_RUN_DENIED" | "INVALID_REQUEST";
  message: string;
  fatalForCron: true;
};
type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  finalPromptText?: string;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  replayInvalid?: boolean;
  livenessState?: EmbeddedRunLivenessState;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  terminalReplyKind?: "silent-empty";
  yielded?: boolean;
  error?: {
    kind: "context_overflow" | "compaction_failure" | "role_ordering" | "image_size" | "retry_limit" | "hook_block";
    message: string;
  };
  failureSignal?: EmbeddedRunFailureSignal; /** Stop reason for the agent run (e.g., "completed", "tool_calls"). */
  stopReason?: string; /** Pending tool calls when stopReason is "tool_calls". */
  pendingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  executionTrace?: ExecutionTrace;
  requestShaping?: RequestShapingTrace;
  promptSegments?: PromptSegmentTrace[];
  toolSummary?: ToolSummaryTrace;
  completion?: CompletionTrace;
  contextManagement?: ContextManagementTrace;
};
type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
    isReasoning?: boolean;
    audioAsVoice?: boolean;
    trustedLocalMedia?: boolean;
    channelData?: Record<string, unknown>;
  }>;
  meta: EmbeddedPiRunMeta;
  diagnosticTrace?: DiagnosticTraceContext;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  acceptedSessionSpawns?: AcceptedSessionSpawn[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  successfulCronAdds?: number;
};
type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string; /** Structured failure metadata used by model fallback classification. */
  failure?: {
    reason?: string;
    status?: number;
    code?: string;
    rawError?: string;
  };
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
    sessionId?: string;
    sessionFile?: string;
  };
};
type EmbeddedFullAccessBlockedReason = "sandbox" | "host-policy" | "channel" | "runtime";
//#endregion
//#region src/agents/bash-tools.exec-types.d.ts
type ExecToolDefaults = {
  hasCronTool?: boolean;
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  trigger?: string;
  node?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  safeBinTrustedDirs?: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  approvalWarningText?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalFollowupMode?: "agent" | "direct";
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  /** `session.mainKey` from the runtime config; passed through into
   *  runExecProcess so background-exit notifications can remap cron-run
   *  session keys to the agent's main queue without an ambient config load. */
  mainKey?: string;
  /** `session.scope` from the runtime config; passed alongside `mainKey`
   *  so the cron-run remap can route global-scope agents to the "global"
   *  queue instead of agent-main. */
  sessionScope?: "per-sender" | "global"; /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  accountId?: string;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  cwd?: string;
};
type ExecApprovalFollowupOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  timedOut: boolean;
  aggregated: string;
  reason?: string;
};
type ExecApprovalFollowupContext = {
  approvalId: string;
  sessionId: string;
  trigger?: string;
  outcome: ExecApprovalFollowupOutcome;
};
type ExecApprovalFollowupFactory = (context: ExecApprovalFollowupContext) => string | undefined | Promise<string | undefined>;
type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
};
//#endregion
//#region src/agents/command/shared-types.d.ts
type AgentStreamParams = {
  /** Provider stream params override (best-effort). */temperature?: number;
  topP?: number;
  maxTokens?: number; /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
  responseFormat?: Record<string, unknown>;
};
type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; /** Strict argument enforcement (Responses API). Propagated from the request. */
    strict?: boolean;
  };
};
//#endregion
//#region src/agents/generated-attachments.d.ts
type AgentGeneratedAttachment = {
  type?: "image" | "audio" | "video" | "file";
  path?: string;
  url?: string;
  mediaUrl?: string;
  filePath?: string;
  mimeType?: string;
  name?: string;
};
//#endregion
//#region src/agents/internal-event-contract.d.ts
declare const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION: "task_completion";
declare const AGENT_INTERNAL_EVENT_SOURCES: readonly ["subagent", "cron", "image_generation", "video_generation", "music_generation"];
declare const AGENT_INTERNAL_EVENT_STATUSES: readonly ["ok", "timeout", "error", "unknown"];
type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];
//#endregion
//#region src/agents/internal-runtime-context.d.ts
declare const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";
//#endregion
//#region src/agents/internal-events.d.ts
type AgentTaskCompletionInternalEvent = {
  type: typeof AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION;
  source: AgentInternalEventSource;
  childSessionKey: string;
  childSessionId?: string;
  announceType: string;
  taskLabel: string;
  status: AgentInternalEventStatus;
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  replyInstruction: string;
};
type AgentInternalEvent = AgentTaskCompletionInternalEvent;
//#endregion
//#region src/agents/pi-embedded-payloads.d.ts
type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};
//#endregion
//#region src/agents/pi-embedded-block-chunker.d.ts
type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence"; /** When true, prefer \n\n paragraph boundaries once minChars has been satisfied. */
  flushOnParagraph?: boolean;
};
declare class EmbeddedBlockChunker {
  #private;
  constructor(chunking: BlockReplyChunking);
  append(text: string): void;
  reset(): void;
  get bufferedText(): string;
  hasBuffered(): boolean;
  drain(params: {
    force: boolean;
    emit: (chunk: string) => void;
  }): void;
}
//#endregion
//#region src/agents/pi-embedded-subscribe.shared-types.d.ts
type ToolResultFormat = "markdown" | "plain";
type ToolProgressDetailMode = "explain" | "raw";
//#endregion
//#region src/agents/system-prompt.types.d.ts
type PromptMode = "full" | "minimal" | "none";
type SilentReplyPromptMode = "generic" | "none";
//#endregion
//#region src/agents/pi-embedded-runner/run/auth-profile-failure-policy.types.d.ts
type AuthProfileFailurePolicy = "shared" | "local";
//#endregion
//#region src/agents/pi-embedded-runner/run/params.d.ts
type EmbeddedRunTrigger = "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
type CurrentInboundPromptContext = {
  text: string;
  promptJoiner?: "\n\n" | "\n" | " ";
};
type RunEmbeddedPiAgentParams = {
  sessionId: string;
  sessionKey?: string; /** Session-like key for sandbox and tool-policy resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  agentId?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string; /** What initiated this agent run: "user", "heartbeat", "cron", "memory", "overflow", or "manual". */
  trigger?: EmbeddedRunTrigger; /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string; /** Relative workspace path that memory-triggered writes are allowed to append to. */
  memoryFlushWritePath?: string; /** Delivery target for topic/thread routing. */
  messageTo?: string; /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number; /** Group id for channel-level tool policy resolution. */
  groupId?: string | null; /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null; /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null; /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[]; /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null; /** Whether workspaceDir points at the canonical agent workspace for bootstrap purposes. */
  isCanonicalWorkspace?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null; /** Trusted sender identity bit for command/channel-action auth. */
  senderIsOwner?: boolean; /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string; /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string; /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number; /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched"; /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: {
    value: boolean;
  }; /** Require explicit message tool targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean; /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean; /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean; /** Explicit system prompt mode override for trusted callers. */
  promptMode?: PromptMode; /** Keep the message tool available even when a narrow profile would omit it. */
  forceMessageTool?: boolean; /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean; /** Keep the heartbeat response tool available even when a narrow profile would omit it. */
  forceHeartbeatTool?: boolean; /** Allow runtime plugins for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string; /** User-visible prompt body to submit and persist; runtime context travels separately. */
  transcriptPrompt?: string;
  currentInboundEventKind?: InboundEventKind;
  currentInboundContext?: CurrentInboundPromptContext;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[]; /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[]; /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  provider?: string;
  model?: string; /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[]; /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string; /** Explicit runtime override selected for this turn. Unlike agentHarnessId, this may force PI. */
  agentHarnessRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  fastMode?: boolean;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  toolProgressDetail?: ToolProgressDetailMode; /** If true, suppress tool error warning payloads for this run (including mutating tools). */
  suppressToolErrorWarnings?: boolean; /** Bootstrap context mode for workspace file injection. */
  bootstrapContextMode?: "full" | "lightweight"; /** Run kind hint for context mode behavior. */
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron"; /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[]; /** Seen bootstrap truncation warning signatures for this session (once mode dedupe). */
  bootstrapPromptWarningSignaturesSeen?: string[]; /** Last shown bootstrap truncation warning signature for this session. */
  bootstrapPromptWarningSignature?: string;
  execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node" | "notifyOnExit" | "notifyOnExitEmptySuccess">;
  bashElevated?: ExecElevatedDefaults;
  timeoutMs: number;
  /**
   * Explicit per-run timeout override, in milliseconds, when the caller knows
   * the run was launched with a deliberate per-run value (e.g. a cron payload's
   * `timeoutSeconds`) rather than inheriting `agents.defaults.timeoutSeconds`.
   * When set, the LLM idle watchdog honors this value directly instead of
   * inferring "explicitness" from `timeoutMs !== agents.defaults.timeoutSeconds`,
   * which fails when the explicit value happens to numerically equal the agent
   * default.
   */
  runTimeoutOverrideMs?: number;
  runId: string;
  abortSignal?: AbortSignal;
  onExecutionStarted?: () => void;
  onExecutionPhase?: (info: {
    phase: EmbeddedAgentExecutionPhase;
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    tool?: string;
    toolCallId?: string;
    itemId?: string;
    firstModelCallStarted?: boolean;
  }) => void;
  onRunProgress?: (info: {
    reason: string;
    provider?: string;
    model?: string;
    backend?: string;
  }) => void;
  replyOperation?: ReplyOperation;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onPartialReply?: (payload: PartialReplyPayload) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => void | Promise<void>;
  /**
   * Emit lifecycle "finishing" when the model turn ends; the caller owns the
   * final lifecycle "end" after durable post-turn maintenance completes.
   */
  deferTerminalLifecycleEnd?: boolean;
  lane?: string;
  enqueue?: CommandQueueEnqueueFn;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPromptMode?: SilentReplyPromptMode;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  /**
   * Treat a clean empty assistant stop as an intentional silent reply.
   * Only set when the caller's prompt policy already allows an exact NO_REPLY
   * final answer for silence.
   */
  allowEmptyAssistantReplyAsSilent?: boolean;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  /**
   * Allow a single run attempt even when all auth profiles are in cooldown,
   * but only for inferred transient cooldowns like `rate_limit` or `overloaded`.
   *
   * This is used by model fallback when trying sibling models on providers
   * where transient service pressure is often model-scoped.
   */
  allowTransientCooldownProbe?: boolean;
  suppressNextUserMessagePersistence?: boolean;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  suppressAssistantErrorPersistence?: boolean;
  onUserMessagePersisted?: (message: Extract<AgentMessage, {
    role: "user";
  }>) => void;
  onAssistantErrorMessagePersisted?: (message: Extract<AgentMessage, {
    role: "assistant";
  }>) => void;
  /**
   * Dispose bundled MCP runtimes when the overall run ends instead of preserving
   * the session-scoped cache. Intended for one-shot local CLI runs that must
   * exit promptly after emitting the final JSON result.
   */
  cleanupBundleMcpOnRunEnd?: boolean;
};
//#endregion
export { normalizeHeartbeatToolResponse as C, HeartbeatToolResponse as S, AgentRunTimeoutPhase as _, BlockReplyChunking as a, AcceptedSessionSpawn as b, OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE as c, ExecElevatedDefaults as d, ExecToolDefaults as f, EmbeddedRunLivenessState as g, EmbeddedPiRunResult as h, PromptMode as i, AgentStreamParams as l, EmbeddedPiRunMeta as m, EmbeddedRunTrigger as n, EmbeddedBlockChunker as o, EmbeddedPiCompactResult as p, RunEmbeddedPiAgentParams as r, AgentInternalEvent as s, CurrentInboundPromptContext as t, ClientToolDefinition as u, MessagingToolSend as v, HEARTBEAT_RESPONSE_TOOL_NAME as x, MessagingToolSourceReplyPayload as y };