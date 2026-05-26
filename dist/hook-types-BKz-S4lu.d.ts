import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { _n as TtsAutoMode } from "./types.channels-C67UBRPK.js";
import { a as SourceReplyDeliveryMode, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { t as DiagnosticTraceContext } from "./diagnostic-trace-context-DcbwO2-o.js";
import { t as FinalizedMsgContext } from "./templating-DbSpLCuR.js";
import { n as ReplyDispatcher, t as ReplyDispatchKind } from "./reply-dispatcher.types-ZeVAzUxF.js";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/plugins/hook-before-agent-start.types.d.ts
type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};
type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */prompt: string; /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};
type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */modelOverride?: string; /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
};
type PluginHookBeforePromptBuildEvent = {
  prompt: string; /** Session messages prepared for this run. */
  messages: unknown[];
};
type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};
declare const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS: readonly ["systemPrompt", "prependContext", "appendContext", "prependSystemContext", "appendSystemContext"];
/**
 * @deprecated Use before_model_resolve and before_prompt_build.
 *
 * Legacy compatibility hook that combines both phases.
 */
type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  runId?: string; /** Optional because legacy hook can run in pre-session phase. */
  messages?: unknown[];
};
/** @deprecated Use before_model_resolve and before_prompt_build result types. */
type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult & PluginHookBeforeModelResolveResult;
/** @deprecated Use before_model_resolve override result types. */
type PluginHookBeforeAgentStartOverrideResult = Omit<PluginHookBeforeAgentStartResult, keyof PluginHookBeforePromptBuildResult>;
declare const stripPromptMutationFieldsFromLegacyHookResult: (result: PluginHookBeforeAgentStartResult | void) => PluginHookBeforeAgentStartOverrideResult | void;
//#endregion
//#region src/plugins/hook-decision-types.d.ts
/**
 * Structured decision returned by gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 */
type HookDecision = HookDecisionPass | HookDecisionBlock;
/** Content is fine. Proceed normally. */
type HookDecisionPass = {
  outcome: "pass";
};
/**
 * Content is blocked. `reason` is internal plugin-local detail; core must not log,
 * persist, broadcast, or expose it verbatim. `message` is user-facing detail.
 */
type HookDecisionBlock = {
  outcome: "block"; /** Internal plugin-local reason. Do not log, persist, broadcast, or expose verbatim. */
  reason: string; /** Optional user-facing detail included in the block response envelope. */
  message?: string; /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
  category?: string; /** Opaque metadata for the plugin's own use. Core does not interpret it. */
  metadata?: Record<string, unknown>;
};
/** Outcomes valid for input gates (before_agent_run). */
type InputGateDecision = HookDecisionPass | HookDecisionBlock;
/**
 * A gate hook decision paired with the pluginId that produced it.
 * Returned by gate hook runners so callers can
 * attribute blocked entries and audit events to the originating plugin.
 */
type GateHookResult<TDecision extends HookDecision = HookDecision> = {
  decision: TDecision;
  pluginId: string;
};
//#endregion
//#region src/plugins/conversation-binding.types.d.ts
type PluginConversationBindingRequestParams = {
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};
type PluginConversationBindingResolutionDecision = "allow-once" | "allow-always" | "deny";
type PluginConversationBinding = {
  bindingId: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
  boundAt: number;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};
type PluginConversationBindingRequestResult = {
  status: "bound";
  binding: PluginConversationBinding;
} | {
  status: "pending";
  approvalId: string;
  reply: ReplyPayload;
} | {
  status: "error";
  message: string;
};
type PluginConversationBindingResolvedEvent = {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: {
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
    requestedBySenderId?: string;
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number;
    };
  };
};
//#endregion
//#region src/plugins/hook-message.types.d.ts
type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  callDepth?: number;
};
type PluginHookInboundClaimContext = PluginHookMessageContext & {
  parentConversationId?: string;
  senderId?: string;
  messageId?: string;
  pluginBinding?: PluginConversationBinding;
};
type PluginHookInboundClaimEvent = {
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  threadId?: string | number;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  isGroup: boolean;
  commandAuthorized?: boolean;
  wasMentioned?: boolean;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  replyToId?: string | number;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageSendingResult = {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  error?: string;
};
//#endregion
//#region src/plugins/host-hook-json.d.ts
type PluginJsonPrimitive = string | number | boolean | null;
type PluginJsonValue = PluginJsonPrimitive | PluginJsonValue[] | {
  [key: string]: PluginJsonValue;
};
//#endregion
//#region src/plugins/host-hook-turn-types.d.ts
type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";
type PluginNextTurnInjection = {
  sessionKey: string;
  text: string;
  idempotencyKey?: string;
  placement?: PluginNextTurnInjectionPlacement;
  ttlMs?: number;
  metadata?: PluginJsonValue;
};
type PluginNextTurnInjectionRecord = Omit<PluginNextTurnInjection, "sessionKey"> & {
  id: string;
  pluginId: string;
  pluginName?: string;
  createdAt: number;
  placement: PluginNextTurnInjectionPlacement;
};
type PluginNextTurnInjectionEnqueueResult = {
  enqueued: boolean;
  id: string;
  sessionKey: string;
};
type PluginAgentTurnPrepareEvent = {
  prompt: string;
  messages: AgentMessage[] | unknown[];
  queuedInjections: PluginNextTurnInjectionRecord[];
};
type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};
type PluginHeartbeatPromptContributionEvent = {
  sessionKey?: string;
  agentId?: string;
  heartbeatName?: string;
};
type PluginHeartbeatPromptContributionResult = {
  prependContext?: string;
  appendContext?: string;
};
//#endregion
//#region src/plugins/hook-types.d.ts
type PluginHookName = "before_model_resolve" | "agent_turn_prepare" | "before_prompt_build" | "before_agent_start" | "before_agent_reply" | "model_call_started" | "model_call_ended" | "llm_input" | "llm_output" | "before_agent_finalize" | "agent_end" | "before_compaction" | "after_compaction" | "before_reset" | "inbound_claim" | "message_received" | "message_sending" | "message_sent" | "before_tool_call" | "after_tool_call" | "tool_result_persist" | "before_message_write" | "session_start" | "session_end" | "subagent_spawning" | "subagent_delivery_target" | "subagent_spawned" | "subagent_ended" /** @deprecated Use gateway_stop. */ | "deactivate" | "gateway_start" | "gateway_stop" | "heartbeat_prompt_contribution" | "cron_changed" | "before_dispatch" | "reply_dispatch" | "before_install" | "before_agent_run";
declare const PLUGIN_HOOK_NAMES: readonly ["before_model_resolve", "agent_turn_prepare", "before_prompt_build", "before_agent_start", "before_agent_reply", "model_call_started", "model_call_ended", "llm_input", "llm_output", "before_agent_finalize", "agent_end", "before_compaction", "after_compaction", "before_reset", "inbound_claim", "message_received", "message_sending", "message_sent", "before_tool_call", "after_tool_call", "tool_result_persist", "before_message_write", "session_start", "session_end", "subagent_spawning", "subagent_delivery_target", "subagent_spawned", "subagent_ended", "deactivate", "gateway_start", "gateway_stop", "heartbeat_prompt_contribution", "cron_changed", "before_dispatch", "reply_dispatch", "before_install", "before_agent_run"];
declare const isPluginHookName: (hookName: unknown) => hookName is PluginHookName;
declare const PROMPT_INJECTION_HOOK_NAMES: readonly ["agent_turn_prepare", "before_prompt_build", "before_agent_start", "heartbeat_prompt_contribution"];
type PromptInjectionHookName = (typeof PROMPT_INJECTION_HOOK_NAMES)[number];
declare const isPromptInjectionHookName: (hookName: PluginHookName) => boolean;
declare const CONVERSATION_HOOK_NAMES: readonly ["before_model_resolve", "before_agent_reply", "llm_input", "llm_output", "before_agent_finalize", "agent_end", "before_agent_run"];
type ConversationHookName = (typeof CONVERSATION_HOOK_NAMES)[number];
declare const isConversationHookName: (hookName: PluginHookName) => boolean;
type PluginHookAgentContext = {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string; /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};
type PluginHookContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";
type PluginHookBeforeAgentReplyEvent = {
  cleanedBody: string;
};
type PluginHookBeforeAgentReplyResult = {
  handled: boolean;
  reply?: ReplyPayload;
  reason?: string;
};
type PluginHookLlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  tools?: unknown[];
};
type PluginHookModelCallBaseEvent = {
  runId: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string; /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};
type PluginHookModelCallStartedEvent = PluginHookModelCallBaseEvent;
type PluginHookModelCallEndedEvent = PluginHookModelCallBaseEvent & {
  durationMs: number;
  outcome: "completed" | "error";
  errorCategory?: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  upstreamRequestIdHash?: string;
};
type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string; /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
  /**
   * Fully resolved provider/model ref used for the call.
   *
   * This intentionally keeps the provider prefix so operator tooling can
   * distinguish e.g. openai-codex/gpt-5.4 from codex/gpt-5.4 even when display
   * names collapse to just the model id.
   */
  resolvedRef?: string;
  /**
   * Harness/backend responsible for the model loop. Kept separate from
   * `resolvedRef` so provider/model consumers keep a stable parse contract.
   */
  harnessId?: string; /** The original user prompt that produced this output. */
  prompt?: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};
type PluginHookAgentEndEvent = {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};
type PluginHookBeforeAgentFinalizeEvent = {
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  transcriptPath?: string;
  stopHookActive: boolean;
  lastAssistantMessage?: string;
  messages?: unknown[];
};
type PluginHookBeforeAgentFinalizeResult = {
  /**
   * continue: accept normal finalization.
   * revise: block finalization and ask the harness for another model pass.
   * finalize: force finalization even if another hook requested revision.
   */
  action?: "continue" | "revise" | "finalize";
  reason?: string;
  retry?: {
    instruction: string;
    idempotencyKey?: string;
    maxAttempts?: number;
  };
};
type PluginHookBeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
};
type PluginHookBeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};
type PluginHookAfterCompactionEvent = {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile?: string;
};
type PluginHookInboundClaimResult = {
  handled: boolean;
  reply?: ReplyPayload;
};
type PluginHookBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
};
type PluginHookBeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};
type PluginHookBeforeDispatchResult = {
  handled: boolean;
  text?: string;
};
type PluginHookReplyDispatchEvent = {
  ctx: FinalizedMsgContext;
  runId?: string;
  sessionKey?: string;
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries: boolean;
  sendPolicy: "allow" | "deny";
  isTailDispatch?: boolean;
};
type PluginHookReplyDispatchContext = {
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  abortSignal?: AbortSignal;
  onReplyStart?: () => Promise<void> | void;
  recordProcessed: (outcome: "completed" | "skipped" | "error", opts?: {
    reason?: string;
    error?: string;
  }) => void;
  markIdle: (reason: string) => void;
};
type PluginHookReplyDispatchResult = {
  handled: boolean;
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};
type PluginHookToolKind = "code_mode_exec";
type PluginHookToolInputKind = "javascript" | "typescript";
type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  toolName: string; /** Host-authoritative discriminator for tools that intentionally share names. */
  toolKind?: PluginHookToolKind; /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  getSessionExtension?: (namespace: string) => PluginJsonValue | undefined;
  channelId?: string;
};
type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>; /** Host-authoritative discriminator for tools that intentionally share names. */
  toolKind?: PluginHookToolKind; /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
  toolInputKind?: PluginHookToolInputKind;
  runId?: string;
  toolCallId?: string;
  /**
   * Optional best-effort destination path hints the host derived from `params`
   * for well-known tool envelopes (e.g. `apply_patch`).
   *
   * This is a convenience hint, not an authoritative parse result: the host's
   * extractor may be intentionally lenient and can return paths for malformed
   * or partial envelopes. Plugins may use `derivedPaths` as a fast path, but
   * should parse and validate `params` themselves when correctness or policy
   * decisions depend on the exact set of affected paths. Absent for tools the
   * host does not know how to derive paths for.
   */
  derivedPaths?: readonly string[];
};
declare const PluginApprovalResolutions: {
  readonly ALLOW_ONCE: "allow-once";
  readonly ALLOW_ALWAYS: "allow-always";
  readonly DENY: "deny";
  readonly TIMEOUT: "timeout";
  readonly CANCELLED: "cancelled";
};
type PluginApprovalResolution = (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];
type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
  };
};
type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};
type PluginHookToolResultPersistContext = {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
};
type PluginHookToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  message: AgentMessage;
  isSynthetic?: boolean;
};
type PluginHookToolResultPersistResult = {
  message?: AgentMessage;
};
type PluginHookBeforeMessageWriteEvent = {
  message: AgentMessage;
  sessionKey?: string;
  agentId?: string;
};
type PluginHookBeforeMessageWriteResult = {
  block?: boolean;
  message?: AgentMessage;
};
type PluginHookSessionContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};
type PluginHookSessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};
type PluginHookSessionEndReason = "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "shutdown" | "restart" | "unknown";
type PluginHookSessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
};
type PluginHookSubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};
type PluginHookSubagentTargetKind = "subagent" | "acp";
type PluginHookSubagentSpawnBase = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  threadRequested: boolean;
};
type PluginHookSubagentSpawningEvent = PluginHookSubagentSpawnBase;
type PluginHookSubagentSpawningResult = {
  status: "ok";
  /**
   * @deprecated Core now resolves thread-bound spawn routing from session
   * bindings and channel route projection. Keep returning this only for
   * compatibility with older OpenClaw runtimes.
   */
  threadBindingReady?: boolean;
  /**
   * @deprecated Use channel `resolveDeliveryTarget` plus core
   * `SessionBindingRecord` projection instead of returning an ad hoc
   * delivery route from this hook.
   */
  deliveryOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
} | {
  status: "error";
  error: string;
};
type PluginHookSubagentDeliveryTargetEvent = {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childRunId?: string;
  spawnMode?: "run" | "session";
  expectsCompletionMessage: boolean;
};
/**
 * @deprecated Core route projection resolves subagent delivery targets from
 * `SessionBindingRecord` and channel `resolveDeliveryTarget`. This hook result
 * remains for plugin compatibility during the transition.
 */
type PluginHookSubagentDeliveryTargetResult = {
  origin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};
type PluginHookSubagentSpawnedEvent = PluginHookSubagentSpawnBase & {
  runId: string;
};
type PluginHookSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: PluginHookSubagentTargetKind;
  reason: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId?: string;
  endedAt?: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};
type PluginHookGatewayContext = {
  port?: number;
  config?: OpenClawConfig;
  workspaceDir?: string;
  getCron?: () => PluginHookGatewayCronService | undefined;
};
type PluginHookGatewayStartEvent = {
  port: number;
};
type PluginHookGatewayStopEvent = {
  reason?: string;
};
type PluginHookGatewayCronRunStatus = "ok" | "error" | "skipped";
type PluginHookGatewayCronDeliveryStatus = "not-requested" | "delivered" | "not-delivered" | "unknown";
type PluginHookGatewayCronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: PluginHookGatewayCronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureNotificationDelivered?: boolean;
  lastFailureNotificationDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  lastFailureNotificationDeliveryError?: string;
};
type PluginHookGatewayCronJob = {
  id: string; /** Agent id that owns this cron job. */
  agentId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: {
    kind: "cron";
    expr?: string;
    tz?: string;
    staggerMs?: number;
  } | {
    kind: "at";
    at?: string;
  } | {
    kind: "every";
    everyMs?: number;
    anchorMs?: number;
  };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    text?: string;
  };
  state?: PluginHookGatewayCronJobState;
  createdAtMs?: number;
  updatedAtMs?: number;
};
type PluginHookCronChangedEvent = {
  action: "added" | "updated" | "removed" | "started" | "finished";
  jobId: string;
  job?: PluginHookGatewayCronJob; /** Top-level session target for downstream routing (mirrors job.sessionTarget). */
  sessionTarget?: string; /** Agent id that owns this cron job (mirrors job.agentId). */
  agentId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: PluginHookGatewayCronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
};
type PluginHookGatewayCronCreateInput = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: {
    kind: string;
    expr: string;
    tz?: string;
  };
  sessionTarget: string;
  wakeMode: string;
  payload: {
    kind: string;
    text?: string;
  };
};
type PluginHookGatewayCronUpdateInput = Partial<PluginHookGatewayCronCreateInput>;
type PluginHookGatewayCronRemoveResult = {
  removed?: boolean;
};
type PluginHookGatewayCronService = {
  list: (opts?: {
    includeDisabled?: boolean;
  }) => Promise<PluginHookGatewayCronJob[]>;
  add: (input: PluginHookGatewayCronCreateInput) => Promise<unknown>;
  update: (id: string, patch: PluginHookGatewayCronUpdateInput) => Promise<unknown>;
  remove: (id: string) => Promise<PluginHookGatewayCronRemoveResult>;
};
type PluginInstallTargetType = "skill" | "plugin";
type PluginInstallRequestKind = "skill-install" | "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm" | "plugin-git";
type PluginInstallSourcePathKind = "file" | "directory";
type PluginInstallFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
};
type PluginHookBeforeInstallRequest = {
  kind: PluginInstallRequestKind;
  mode: "install" | "update";
  requestedSpecifier?: string;
};
type PluginHookBeforeInstallBuiltinScan = {
  status: "ok" | "error";
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: PluginInstallFinding[];
  error?: string;
};
type PluginHookBeforeInstallSkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};
type PluginHookBeforeInstallSkill = {
  installId: string;
  installSpec?: PluginHookBeforeInstallSkillInstallSpec;
};
type PluginHookBeforeInstallPlugin = {
  pluginId: string;
  contentType: "bundle" | "package" | "file";
  packageName?: string;
  manifestId?: string;
  version?: string;
  extensions?: string[];
};
type PluginHookBeforeInstallContext = {
  targetType: PluginInstallTargetType;
  requestKind: PluginInstallRequestKind;
  origin?: string;
};
type PluginHookBeforeInstallEvent = {
  targetType: PluginInstallTargetType;
  targetName: string;
  sourcePath: string;
  sourcePathKind: PluginInstallSourcePathKind;
  origin?: string;
  request: PluginHookBeforeInstallRequest;
  builtinScan: PluginHookBeforeInstallBuiltinScan;
  skill?: PluginHookBeforeInstallSkill;
  plugin?: PluginHookBeforeInstallPlugin;
};
type PluginHookBeforeInstallResult = {
  findings?: PluginInstallFinding[];
  block?: boolean;
  blockReason?: string;
};
/** Event payload for the before_agent_run gate hook. */
type PluginHookBeforeAgentRunEvent = {
  /** The user's message that triggered this run. */prompt: string; /** Loaded session history before the current prompt is submitted. */
  messages: unknown[]; /** Active system prompt prepared for this run. */
  systemPrompt?: string; /** Account identity when available. */
  accountId?: string; /** Channel the message came from. */
  channelId?: string; /** Sender identity when available. */
  senderId?: string; /** Trusted sender identity bit when available. */
  senderIsOwner?: boolean;
};
/** Result type for before_agent_run. Returns pass/block or void (= pass). */
type PluginHookBeforeAgentRunResult = InputGateDecision | void;
type PluginHookHandlerMap = {
  agent_turn_prepare: (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | void> | PluginAgentTurnPrepareResult | void;
  before_model_resolve: (event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeModelResolveResult | void> | PluginHookBeforeModelResolveResult | void;
  before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void; /** @deprecated Use before_model_resolve and before_prompt_build. */
  before_agent_start: (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | void> | PluginHookBeforeAgentStartResult | void;
  before_agent_reply: (event: PluginHookBeforeAgentReplyEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentReplyResult | void> | PluginHookBeforeAgentReplyResult | void;
  model_call_started: (event: PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  model_call_ended: (event: PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  llm_input: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  llm_output: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  before_agent_finalize: (event: PluginHookBeforeAgentFinalizeEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentFinalizeResult | void> | PluginHookBeforeAgentFinalizeResult | void;
  agent_end: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  before_compaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  after_compaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  before_reset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  inbound_claim: (event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | void> | PluginHookInboundClaimResult | void;
  before_dispatch: (event: PluginHookBeforeDispatchEvent, ctx: PluginHookBeforeDispatchContext) => Promise<PluginHookBeforeDispatchResult | void> | PluginHookBeforeDispatchResult | void;
  reply_dispatch: (event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext) => Promise<PluginHookReplyDispatchResult | void> | PluginHookReplyDispatchResult | void;
  message_received: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
  message_sending: (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void;
  message_sent: (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
  before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void;
  after_tool_call: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void> | void;
  tool_result_persist: (event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext) => PluginHookToolResultPersistResult | void;
  before_message_write: (event: PluginHookBeforeMessageWriteEvent, ctx: {
    agentId?: string;
    sessionKey?: string;
  }) => PluginHookBeforeMessageWriteResult | void;
  session_start: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void> | void;
  session_end: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void> | void;
  subagent_spawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentSpawningResult | void> | PluginHookSubagentSpawningResult | void;
  subagent_delivery_target: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentDeliveryTargetResult | void> | PluginHookSubagentDeliveryTargetResult | void;
  subagent_spawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void;
  subagent_ended: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void;
  /**
   * Deprecated compatibility alias for gateway_stop.
   *
   * New plugins should register gateway_stop directly; the loader normalizes
   * deactivate registrations onto gateway_stop so cleanup handlers still run
   * during Gateway shutdown.
   *
   * @deprecated Use gateway_stop.
   */
  deactivate: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
  gateway_start: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
  gateway_stop: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
  heartbeat_prompt_contribution: (event: PluginHeartbeatPromptContributionEvent, ctx: PluginHookAgentContext) => Promise<PluginHeartbeatPromptContributionResult | void> | PluginHeartbeatPromptContributionResult | void;
  cron_changed: (event: PluginHookCronChangedEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
  before_install: (event: PluginHookBeforeInstallEvent, ctx: PluginHookBeforeInstallContext) => Promise<PluginHookBeforeInstallResult | void> | PluginHookBeforeInstallResult | void;
  before_agent_run: (event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentRunResult> | PluginHookBeforeAgentRunResult;
};
type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  timeoutMs?: number;
  source: string;
};
//#endregion
export { PluginHookModelCallStartedEvent as $, PLUGIN_PROMPT_MUTATION_RESULT_FIELDS as $t, PluginHookBeforeMessageWriteResult as A, isPromptInjectionHookName as At, PluginHookGatewayCronJobState as B, PluginHookInboundClaimEvent as Bt, PluginHookBeforeInstallEvent as C, PluginInstallFinding as Ct, PluginHookBeforeInstallSkill as D, PromptInjectionHookName as Dt, PluginHookBeforeInstallResult as E, PluginInstallTargetType as Et, PluginHookCronChangedEvent as F, PluginNextTurnInjection as Ft, PluginHookGatewayStartEvent as G, PluginHookMessageSentEvent as Gt, PluginHookGatewayCronRunStatus as H, PluginHookMessageReceivedEvent as Ht, PluginHookGatewayContext as I, PluginNextTurnInjectionEnqueueResult as It, PluginHookInboundClaimResult as J, PluginConversationBindingRequestResult as Jt, PluginHookGatewayStopEvent as K, PluginConversationBinding as Kt, PluginHookGatewayCronCreateInput as L, PluginNextTurnInjectionRecord as Lt, PluginHookBeforeToolCallEvent as M, PluginAgentTurnPrepareResult as Mt, PluginHookBeforeToolCallResult as N, PluginHeartbeatPromptContributionEvent as Nt, PluginHookBeforeInstallSkillInstallSpec as O, isConversationHookName as Ot, PluginHookContextWindowSource as P, PluginHeartbeatPromptContributionResult as Pt, PluginHookModelCallEndedEvent as Q, InputGateDecision as Qt, PluginHookGatewayCronDeliveryStatus as R, PluginJsonValue as Rt, PluginHookBeforeInstallContext as S, PluginHookToolResultPersistResult as St, PluginHookBeforeInstallRequest as T, PluginInstallSourcePathKind as Tt, PluginHookGatewayCronService as U, PluginHookMessageSendingEvent as Ut, PluginHookGatewayCronRemoveResult as V, PluginHookMessageContext as Vt, PluginHookGatewayCronUpdateInput as W, PluginHookMessageSendingResult as Wt, PluginHookLlmOutputEvent as X, PluginConversationBindingResolvedEvent as Xt, PluginHookLlmInputEvent as Y, PluginConversationBindingResolutionDecision as Yt, PluginHookModelCallBaseEvent as Z, GateHookResult as Zt, PluginHookBeforeCompactionEvent as _, PluginHookToolContext as _t, PluginApprovalResolution as a, PluginHookBeforeModelResolveResult as an, PluginHookSessionContext as at, PluginHookBeforeDispatchResult as b, PluginHookToolResultPersistContext as bt, PluginHookAfterToolCallEvent as c, stripPromptMutationFieldsFromLegacyHookResult as cn, PluginHookSessionStartEvent as ct, PluginHookBeforeAgentFinalizeEvent as d, PluginHookSubagentDeliveryTargetResult as dt, PluginHookBeforeAgentStartEvent as en, PluginHookName as et, PluginHookBeforeAgentFinalizeResult as f, PluginHookSubagentEndedEvent as ft, PluginHookBeforeAgentRunResult as g, PluginHookSubagentTargetKind as gt, PluginHookBeforeAgentRunEvent as h, PluginHookSubagentSpawningResult as ht, PROMPT_INJECTION_HOOK_NAMES as i, PluginHookBeforeModelResolveEvent as in, PluginHookReplyDispatchResult as it, PluginHookBeforeResetEvent as j, PluginAgentTurnPrepareEvent as jt, PluginHookBeforeMessageWriteEvent as k, isPluginHookName as kt, PluginHookAgentContext as l, PluginHookSubagentContext as lt, PluginHookBeforeAgentReplyResult as m, PluginHookSubagentSpawningEvent as mt, ConversationHookName as n, PluginHookBeforeAgentStartResult as nn, PluginHookReplyDispatchContext as nt, PluginApprovalResolutions as o, PluginHookBeforePromptBuildEvent as on, PluginHookSessionEndEvent as ot, PluginHookBeforeAgentReplyEvent as p, PluginHookSubagentSpawnedEvent as pt, PluginHookHandlerMap as q, PluginConversationBindingRequestParams as qt, PLUGIN_HOOK_NAMES as r, PluginHookBeforeModelResolveAttachment as rn, PluginHookReplyDispatchEvent as rt, PluginHookAfterCompactionEvent as s, PluginHookBeforePromptBuildResult as sn, PluginHookSessionEndReason as st, CONVERSATION_HOOK_NAMES as t, PluginHookBeforeAgentStartOverrideResult as tn, PluginHookRegistration as tt, PluginHookAgentEndEvent as u, PluginHookSubagentDeliveryTargetEvent as ut, PluginHookBeforeDispatchContext as v, PluginHookToolInputKind as vt, PluginHookBeforeInstallPlugin as w, PluginInstallRequestKind as wt, PluginHookBeforeInstallBuiltinScan as x, PluginHookToolResultPersistEvent as xt, PluginHookBeforeDispatchEvent as y, PluginHookToolKind as yt, PluginHookGatewayCronJob as z, PluginHookInboundClaimContext as zt };