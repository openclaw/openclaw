import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
/**
 * Shared parameter types for embedded-agent run orchestration.
 */
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import type { CronRuntimeAuthority } from "../../../cron/runtime-authority.js";
import type { CronScheduledToolCallerOrigin } from "../../../cron/scheduled-tool-policy.js";
import type { RuntimePluginToolGrant } from "../../../plugins/runtime/tool-grant.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import type { ExplicitSkillSelection } from "../../../skills/types.js";
import type {
  SkillProposalOrigin,
  SkillWorkshopProposalMutationBudget,
  SkillWorkshopRunOptions,
} from "../../../skills/workshop/types.js";
import type { ModelFallbackAvailability } from "../../agent-scope.js";
import type { AssistantErrorTranscript } from "../../assistant-error-transcript.js";
import type { ExecApprovalContinuationPromptRange } from "../../bash-tools.exec-approval-output.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.exec-types.js";
import type {
  AgentRunClientContext,
  AgentRunMessageContext,
  AgentRunChannelContext,
  AgentRunModelOptions,
  AgentRunInputContext,
  AgentRunTranscriptContext,
  AgentRunLifecycle,
  AgentStreamParams,
  ClientToolDefinition,
} from "../../command/shared-types.js";
import type { ConversationRecallContext } from "../../conversation-recall.types.js";
import type { CronCreatorAuthorityCapability } from "../../cron-creator-authority-context.js";
import type {
  BlockReplyChunking,
  EmbeddedAgentEvent,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "../../embedded-agent-subscribe.shared-types.js";
import type { ExecSessionDefaults } from "../../exec-defaults.js";
import type { ExpectedAgentHarnessRuntimeArtifact } from "../../harness/runtime-artifact.types.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import type { PreparedModelThinkingCapability } from "../../model-catalog-lookup.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import type { TrustedSubagentCompletionHandoff } from "../../subagents/announce/subagent-announce-handoff.js";
import type { SilentReplyPromptMode, PromptMode } from "../../system-prompt.types.js";
import type { EmbeddedAgentExecutionPhase } from "../execution-phase.js";
import type { BlockReplyFlushContext } from "../types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
export type { ClientToolDefinition } from "../../command/shared-types.js";

export type EmbeddedRunTrigger = "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";

export type ResolvedToolPromptFinalizer = (params: {
  prompt: string;
  messageToolAvailable: boolean;
}) => string;

type ReasoningStreamPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrls" | "isReasoning" | "isReasoningSnapshot"
> & {
  requiresReasoningProgressOptIn?: boolean;
};

export type CurrentInboundPromptContext = {
  text: string;
  /** Producer-owned fragments for model projection; text remains the legacy rendering. */
  fragments?: import("../../internal-runtime-context.js").RuntimeContextFragment[];
  resumableText?: string;
  promptJoiner?: "\n\n" | "\n" | " ";
  /** Generated goal blocks owned by inbound-context assembly, never user text. */
  injectedGoalContexts?: string[];
};

export type RunEmbeddedAgentParams = {
  /** Detached runs may read session identity but never write its durable transcript or metadata. */
  sessionPersistence?: "durable" | "detached";
  /** Storage-neutral transcript/session target. Defaults to sessionId/sessionKey/agentId. */
  sessionTarget?: AgentRunSessionTarget;
  /** Provider prompt-cache affinity key; distinct from transcript/session identity. */
  promptCacheKey?: string;
  /** Session-like key for sandbox and tool-policy resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  /** Explicit sandbox and tool-policy owner when the policy session key is unscoped. */
  sandboxAgentId?: string;
  /** Out-of-band plugin bindings attached by the run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Raw peer observed by the inbound routing owner, before identity linking. */
  conversationRoutePeerId?: string;
  /** What initiated this agent run: "user", "heartbeat", "cron", "memory", "overflow", or "manual". */
  trigger?: EmbeddedRunTrigger;
  /** Store-private runtime authority forwarded only by the cron execution owner. */
  scheduledRuntimeAuthority?: CronRuntimeAuthority;
  /** A known runtime-specific authority envelope was explicitly cleared. */
  scheduledRuntimeAuthorityRecoveryRequired?: boolean;
  /** Relative workspace path that memory-triggered writes are allowed to append to. */
  memoryFlushWritePath?: string;
  /** Sticky source-turn taint inherited by an internal maintenance run. */
  initialTurnTainted?: boolean;
  /** Delivery target for topic/thread routing. */
  messageTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number;
  /** Trusted channel-configured policy for the admitted conversation turn. */
  conversationToolPolicy?: GroupToolPolicyConfig;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** Whether workspaceDir points at the canonical agent workspace for bootstrap purposes. */
  isCanonicalWorkspace?: boolean;
  /** Transport-native chat/conversation ID for hook identity context. */
  chatId?: string;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  /** Restrict this reconstructed run to restart-safe tools. */
  forceRestartSafeTools?: boolean;
  /** Preserve Code Mode controls for a replay-safe restart recovery turn. */
  forceCodeModeTools?: boolean;
  /** Invocation-owned Code Mode activation; limits still come from config. */
  codeModeOverride?: boolean | "auto";
  /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean;
  /** Disable trajectory persistence for auxiliary runs with no durable session owner. */
  disableTrajectory?: boolean;
  /** Restrict Skill Workshop to a bounded pending-proposal budget for an internal review run. */
  skillWorkshopProposalOnly?: boolean;
  /** Mark proposals created by this internal review as autonomous captures. */
  skillWorkshopAutonomousCapture?: boolean;
  skillWorkshopUpdateProposals?: boolean;
  /** Preserve the foreground run as proposal provenance for an internal review run. */
  skillWorkshopOrigin?: SkillProposalOrigin;
  /** Run-scoped mutation budget shared across internal runner attempts. */
  skillWorkshopProposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  /** Optional state environment for isolated Skill Workshop proposal persistence. */
  skillWorkshopProposalEnv?: NodeJS.ProcessEnv;
  /** Bind an operator-requested revision turn to the exact proposal revision they reviewed. */
  skillWorkshopProposalRevision?: SkillWorkshopRunOptions["proposalRevision"];
  skillLibraryAuthoring?: SkillWorkshopRunOptions["libraryAuthoring"];
  /** Explicit system prompt mode override for trusted callers. */
  promptMode?: PromptMode;
  /** Keep the message tool available even when a narrow profile would omit it. */
  forceMessageTool?: boolean;
  /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  /** Keep the heartbeat response tool available even when a narrow profile would omit it. */
  forceHeartbeatTool?: boolean;
  /** Allow runtime plugins for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  /** @deprecated Use sessionTarget plus sessionId/sessionKey/agentId for runtime identity. */
  sessionFile?: string;
  /** Require file tools to stay within the task workspace without changing exec policy. */
  requireWorkspaceOnly?: true;
  /** Refuse an enabled sandbox that would redirect a review away from its workspace. */
  requireWritableSandbox?: true;
  permissionMode?: SessionEntry["permissionMode"];
  sessionRoot?: string;
  /** Context supplied by internal producers, separate from inbound prompt text. */
  runtimeContextFragments?: import("../../internal-runtime-context.js").RuntimeContextFragment[];
  /** Finalizes caller-owned guidance after the submitted tool surface is known. */
  finalizePromptForResolvedTools?: ResolvedToolPromptFinalizer;
  currentInboundContext?: CurrentInboundPromptContext;
  explicitSkillSelections?: ExplicitSkillSelection[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  provider?: string;
  /** Caller-owned upper bound for this run's effective context budget. */
  contextTokenBudget?: number;
  /** Route-bound thinking capability resolved from the selected prepared catalog row. */
  modelThinkingCapability?: PreparedModelThinkingCapability;
  /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[];
  /** Prepared fallback availability fact shared by selection and failure reporting. */
  modelFallbackAvailability?: ModelFallbackAvailability;
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** Locks the selected model against hooks and fallbacks; does not imply native model ownership. */
  modelSelectionLocked?: boolean;
  /** Explicit runtime override selected for this turn. Unlike agentHarnessId, this may force OpenClaw. */
  agentHarnessRuntimeOverride?: string;
  /** Verified setup continuation: pin both the harness and its local implementation. */
  expectedAgentHarnessRuntimeArtifact?: ExpectedAgentHarnessRuntimeArtifact;
  authProfileIdSource?: "auto" | "user";
  /** Disable fallback from the user-selected auth profile for a verification run. */
  allowAuthProfileFallback?: boolean;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  toolProgressDetail?: ToolProgressDetailMode;
  /** Bootstrap context mode for workspace file injection. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
  /** Preserve the visible tool schemas while allowing execution only for these names. */
  toolExecutionAllow?: readonly string[];
  /** Owner-scoped plugin tool grant; normal policy and deny rules still apply. */
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  /** Consumed in-process subagent-completion capability; never derived from public input. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Host-stamped exact-run capability for late Codex creator-authority capture. */
  cronCreatorAuthorityCapability?: CronCreatorAuthorityCapability;
  /** Ephemeral reason fresh local-operator cron authority cannot survive this queued turn. */
  cronCreatorAuthorityUnavailableReason?: "queued-local-operator";
  /** Canonical persisted exec policy for this session. */
  execSession?: ExecSessionDefaults;
  execOverrides?: Pick<
    ExecToolDefaults,
    | "host"
    | "mode"
    | "security"
    | "ask"
    | "node"
    | "nodeCwd"
    | "notifyOnExit"
    | "notifyOnExitEmptySuccess"
  >;
  bashElevated?: ExecElevatedDefaults;
  /** Trusted approved-exec runtime prompt span awaiting the resolved attempt cap. */
  execApprovalContinuationPromptRange?: ExecApprovalContinuationPromptRange;
  /** Corresponding span in the undecorated transcript prompt. */
  execApprovalContinuationTranscriptPromptRange?: ExecApprovalContinuationPromptRange;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  onExecutionStarted?: (info?: { lifecycleGeneration?: string }) => void;
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
  onLaneWait?: (info: { waitMs: number; queuedAhead: number; waiting?: boolean }) => void;
  onRunProgress?: (info: {
    reason: string;
    provider?: string;
    model?: string;
    backend?: string;
  }) => void;
  onSessionIdChanged?: (sessionId: string) => void;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReplyFlush?: (context: BlockReplyFlushContext) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: ReasoningStreamPayload) => void | Promise<void>;
  streamReasoningInNonStreamModes?: boolean;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  /** Synchronous private observer for the sanitized per-tool result. */
  onAgentToolResult?: (event: { toolName: string; result: unknown; isError: boolean }) => void;
  /** Reports a committed generic recovery compaction before its retry starts. */
  onAutoCompactionSucceeded?: (count: number) => void;
  onAgentEvent?: (evt: EmbeddedAgentEvent) => void | Promise<void>;
  onToolStreamBoundary?: () => void | Promise<void>;
  /**
   * Emit lifecycle "finishing" when the attempt ends; the caller owns the
   * final lifecycle "end" or "error" after fallback and post-turn work settle.
   */
  deferTerminalLifecycle?: boolean;
  /** @deprecated Use deferTerminalLifecycle. */
  deferTerminalLifecycleEnd?: boolean;
  enqueue?: CommandQueueEnqueueFn;
  gitCoauthorPrompt?: string;
  silentReplyPromptMode?: SilentReplyPromptMode;
  internalEvents?: AgentInternalEvent[];
  streamParams?: AgentStreamParams;
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  /** Skip per-chunk live visible-text parsing when no live stream consumer exists (e.g. subagents). */
  suppressLiveStreamOutput?: boolean;
  /**
   * Treat a clean empty assistant stop as an intentional silent reply.
   * Only set when the caller's prompt policy already allows an exact NO_REPLY
   * final answer for silence.
   */
  allowEmptyAssistantReplyAsSilent?: boolean;
  /**
   * Whether this run still owes a visible reply after settled non-reporting tools.
   * Exact configured silence and committed delivery remain terminal outcomes.
   */
  terminalReplyExpectation?: "required" | "optional";
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  /**
   * One-shot helper runs may opt in to executing through the provider's CLI
   * backend instead of the direct-API passthrough when the run targets a CLI
   * runtime provider whose passthrough credentials are subscription-scoped.
   * Anthropic routes direct anthropic-messages calls on subscription OAuth to
   * metered extra-usage billing: without extra-usage balance the passthrough
   * fails closed with a billing error, and with it the run silently draws
   * paid usage instead of plan limits. The CLI backend is the plan-limits
   * path for those credentials. CLI dispatch translates `toolsAllow` into the
   * selectable-backend surface (no native tools, allowlisted loopback MCP
   * tools); the same list bounds the loopback MCP grant server-side, so tools
   * outside it — including the message tool, matching `disableMessageTool`
   * intent — can be neither listed nor called. Leave unset to keep the
   * direct-API passthrough.
   */
  cliBackendDispatch?: "subscription-auth";
  /**
   * Allow a single run attempt even when all auth profiles are in cooldown,
   * but only for inferred transient cooldowns like `rate_limit` or `overloaded`.
   *
   * This is used by model fallback when trying sibling models on providers
   * where transient service pressure is often model-scoped.
   */
  allowTransientCooldownProbe?: boolean;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  assistantErrorTranscript?: AssistantErrorTranscript;
  /** Keep an internal continuation prompt from being replaced by the original prepared turn. */
  skipPreparedUserTurnMessage?: boolean;
  onUserMessagePersistenceInvalidated?: () => void;
} & AgentRunClientContext &
  AgentRunMessageContext &
  AgentRunChannelContext &
  AgentRunModelOptions &
  AgentRunInputContext &
  AgentRunTranscriptContext &
  AgentRunLifecycle;

export type EmbeddedForegroundPromptContext = Pick<
  RunEmbeddedAgentParams,
  | "agentDir"
  | "sandboxAgentId"
  | "promptCacheKey"
  | "reasoningLevel"
  | "messageChannel"
  | "messageProvider"
  | "clientCaps"
  | "gatewayUiCommandTarget"
  | "toolBindings"
  | "chatType"
  | "agentAccountId"
  | "trigger"
  | "messageTo"
  | "messageThreadId"
  | "conversationToolPolicy"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "messageActionTurnCapability"
  | "spawnedBy"
  | "isCanonicalWorkspace"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "approvalReviewerDeviceId"
  | "currentChannelId"
  | "chatId"
  | "channelContext"
  | "currentMessagingTarget"
  | "currentThreadTs"
  | "currentMessageId"
  | "currentInboundAudio"
  | "replyToMode"
  | "requireExplicitMessageTarget"
  | "disableMessageTool"
  | "conversationRecall"
  | "toolOverrides"
  | "permissionMode"
  | "execOverrides"
  | "skillsSnapshot"
  | "currentInboundEventKind"
  | "clientTools"
  | "disableTools"
  | "contextWindow"
  | "promptMode"
  | "forceMessageTool"
  | "enableHeartbeatTool"
  | "forceHeartbeatTool"
  | "allowGatewaySubagentBinding"
  | "extraSystemPrompt"
  | "gitCoauthorPrompt"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
  | "silentReplyPromptMode"
  | "ownerNumbers"
  | "toolsAllow"
  | "runtimePluginToolGrant"
  | "inputProvenance"
  | "scheduledToolPolicy"
  | "modelThinkingCapability"
  | "modelFallbacksOverride"
> & {
  /** SDK observation of the completed attempt; new runs recheck publication availability. */
  githubPublicationAvailable?: boolean;
  agentId: string;
  workspaceDir: string;
  cwd?: string;
  sandboxSessionKey: string;
  cronCreatorCallerOrigin?: CronScheduledToolCallerOrigin;
};
