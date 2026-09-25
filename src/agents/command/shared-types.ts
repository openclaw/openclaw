import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  BlockReplyContext,
  PartialReplyPayload,
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageContent } from "../../llm/types.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../plugins/hook-types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { AdmittedRunContext, PreparedAgentRunAdmission } from "../admitted-run-context.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import type { BlockReplyPayload } from "../embedded-agent-payloads.js";
import type { FastModeAutoProgressState } from "../fast-mode.js";
import type { ContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import type { SessionManager } from "../sessions/index.js";

/** Best-effort provider stream parameter overrides for an agent command. */
export type AgentStreamParams = {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Stop sequences forwarded to the provider (best-effort). */
  stop?: string[];
  /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
  responseFormat?: Record<string, unknown>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

/** Simplified tool definition for client-provided OpenResponses hosted tools. */
export type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** Strict argument enforcement (Responses API). Propagated from the request. */
    strict?: boolean;
  };
};

export type AgentRunClientContext = {
  /** Profile selected from the session's assigned human owner or authenticated human creator, never its latest sender. */
  bootstrapUserProfileId?: string;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  /** Gateway client id for the process that originated this run. */
  clientId?: string;
  gatewayUiCommandTarget?: import("../../gateway/ui-command-target.types.js").GatewayUiCommandTarget;
  /** Host-admitted dashboard authoring without an originating inline renderer. */
  pinnedWidgetAuthoring?: boolean;
};

export type AgentRunMessageContext = {
  agentAccountId?: string;
  /** Opaque host-issued capability for current-turn channel message actions. */
  messageActionTurnCapability?: string;
  /** Trusted sender identity bit for command/channel-action auth. */
  senderIsOwner?: boolean;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** True when the current inbound turn carried audio media. */
  currentInboundAudio?: boolean;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Visible source replies must use the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Action sink available for model-proposed follow-up tasks. */
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** Require explicit message tool targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
};

export type AgentRunChannelContext = {
  /** Canonical transport channel when it differs from the tool-policy provider. */
  messageChannel?: string;
  messageProvider?: string;
  chatType?: ChatType;
  /** Channel-specific identity metadata surfaced to plugin hooks. */
  channelContext?: PluginHookChannelContext;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
};

export type AgentRunModelOptions = {
  /** Vision capability resolved by the run owner from its prepared model catalog. */
  modelHasVision?: boolean;
  /** Session-selected context-window option id carried by the run owner. */
  contextWindow?: string;
  model?: string;
  /** Outer model-fallback owner facts for this admitted attempt. */
  modelRoutingProvenance?: ModelFallbackAttemptProvenance;
  thinkLevel?: ThinkLevel;
  fastMode?: FastMode;
  /** Stable outer-run start time for auto fast-mode cutoff across retries/fallbacks. */
  fastModeStartedAtMs?: number;
  /** Effective auto fast-mode cutoff for this run, in seconds. */
  fastModeAutoOnSeconds?: number;
  /** Shared notification state for nested harnesses that can observe the same tool boundary. */
  fastModeAutoProgressState?: FastModeAutoProgressState;
  /** True when the outer model fallback loop has reached its final candidate. */
  isFinalFallbackAttempt?: boolean;
  authProfileId?: string;
};

export type AgentRunInputContext = {
  workspaceDir: string;
  /** Canonical agent workspace used for bootstrap files when execution runs elsewhere. */
  bootstrapWorkspaceDir?: string;
  agentDir?: string;
  /** Task working directory for tool/runtime execution. Defaults to workspaceDir. */
  cwd?: string;
  /**
   * Run config consumed by core paths (model selection, tools, plugin
   * activation). Plugin harnesses resolve `plugins.entries.<id>.config` from
   * the live global config, NOT from this object — per-run plugin-config
   * overrides are unsupported; use an explicit run param instead.
   */
  config?: OpenClawConfig;
  toolOverrides?: SessionToolOverrides;
  prompt: string;
  /** User-visible prompt body to submit and persist; runtime context travels separately. */
  transcriptPrompt?: string;
  currentInboundEventKind?: InboundEventKind;
  inputProvenance?: InputProvenance;
  extraSystemPrompt?: string;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in the current prompt. */
  media?: MediaFact[];
  skillsSnapshot?: SkillSnapshot;
  ownerNumbers?: string[];
  /** Seen bootstrap truncation warning signatures for this session (once mode dedupe). */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Last shown bootstrap truncation warning signature for this session. */
  bootstrapPromptWarningSignature?: string;
  /** Run kind hint for context mode behavior. */
  bootstrapContextRunKind?: BootstrapContextRunKind;
};

export type AgentRunTranscriptContext = {
  /** Caller-owned in-memory transcript for ephemeral helper runs. */
  sessionManager?: SessionManager;
  sessionId: string;
  sessionKey?: string;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  /** Context engine resolved once by the outer logical-turn owner. */
  contextEngineLogicalTurnLease?: ContextEngineLogicalTurnLease;
  /** Emits immutable attempt facts for selection by the outer logical-turn owner. */
  onContextEngineTurnCandidate?: (facts: ContextEngineTurnAttemptFacts) => void;
  suppressNextUserMessagePersistence?: boolean;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
};

export type AgentRunLifecycle = {
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  /** Already-admitted internal execution; mutually exclusive with preparedRunAdmission. */
  admittedRunContext?: AdmittedRunContext;
  /** Host-only post-prepare continuation, removed before plugin invocation. */
  preparedRunAdmission?: PreparedAgentRunAdmission;
  agentId?: string;
  timeoutMs: number;
  /** Explicit timeout override; equality with the configured default does not imply inheritance. */
  runTimeoutOverrideMs?: number;
  runId: string;
  /** Exact attempt authority attached to the active steering backend. */
  toolAuthorityFingerprint?: string;
  /** Immutable gateway lifecycle ownership captured when this execution was admitted. */
  lifecycleGeneration?: string;
  lane?: string;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  abortSignal?: AbortSignal;
  onPartialReply?: (payload: PartialReplyPayload) => boolean | void | Promise<boolean | void>;
  onBlockReply?: (payload: BlockReplyPayload, context?: BlockReplyContext) => void | Promise<void>;
  replyOperation?: ReplyOperation;
  /**
   * Dispose bundled MCP runtimes when the overall run ends instead of preserving
   * the session-scoped cache. Intended for one-shot local CLI runs that must
   * exit promptly after emitting the final JSON result.
   */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Mark explicit one-shot local CLI runs so plugin tools can release resources promptly. */
  oneShotCliRun?: boolean;
};
