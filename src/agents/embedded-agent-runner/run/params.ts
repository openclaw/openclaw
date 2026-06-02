import type {
  PartialReplyPayload,
  SourceReplyDeliveryMode,
} from "../../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ImageContent } from "../../../llm/types.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import type { SkillSnapshot } from "../../../skills/types.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.exec-types.js";
import type { AgentStreamParams, ClientToolDefinition } from "../../command/shared-types.js";
import type { BlockReplyPayload } from "../../embedded-agent-payloads.js";
import type {
  BlockReplyChunking,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "../../embedded-agent-subscribe.shared-types.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SilentReplyPromptMode } from "../../system-prompt.types.js";
import type { PromptMode } from "../../system-prompt.types.js";
import type { EmbeddedAgentExecutionPhase } from "../execution-phase.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
export type { ClientToolDefinition } from "../../command/shared-types.js";

/** Run origin used for prompt policy, timeout, and heartbeat/memory behavior. */
export type EmbeddedRunTrigger = "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";

/** Current inbound message context that can be prepended without entering persisted transcript. */
export type CurrentInboundPromptContext = {
  text: string;
  /** Shorter version used when replaying or retrying a prompt with bounded context. */
  resumableText?: string;
  /** Separator used when joining current inbound context with the submitted prompt. */
  promptJoiner?: "\n\n" | "\n" | " ";
};

/** Public run-level API for launching an embedded agent turn. */
export type RunEmbeddedAgentParams = {
  sessionId: string;
  /** Logical session key for transcript/policy grouping; may differ from sessionId. */
  sessionKey?: string;
  /** Provider prompt-cache affinity key; distinct from transcript/session identity. */
  promptCacheKey?: string;
  /** Session-like key for sandbox and tool-policy resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  agentId?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  /** What initiated this agent run: "user", "heartbeat", "cron", "memory", "overflow", or "manual". */
  trigger?: EmbeddedRunTrigger;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Relative workspace path that memory-triggered writes are allowed to append to. */
  memoryFlushWritePath?: string;
  /** Delivery target for topic/thread routing. */
  messageTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Whether workspaceDir points at the canonical agent workspace for bootstrap purposes. */
  isCanonicalWorkspace?: boolean;
  senderId?: string | null;
  /** Human display name from the inbound channel, used for prompt and transcript context. */
  senderName?: string | null;
  /** Channel username/handle from the inbound sender, when distinct from display name. */
  senderUsername?: string | null;
  /** E.164 sender phone number for owner/contact checks; never log raw values. */
  senderE164?: string | null;
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
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Require explicit message tool targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean;
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
  sessionFile: string;
  workspaceDir: string;
  /** Task working directory for tool/runtime execution. Defaults to workspaceDir. */
  cwd?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  /** User-visible prompt body to submit and persist; runtime context travels separately. */
  transcriptPrompt?: string;
  currentInboundEventKind?: InboundEventKind;
  /** Ephemeral inbound context shown to the model without mutating the durable user prompt. */
  currentInboundContext?: CurrentInboundPromptContext;
  /** Images already attached to the current prompt before text reference detection. */
  images?: ImageContent[];
  /** Ordering metadata that preserves inline/offloaded image attachment order. */
  imageOrder?: PromptImageOrderEntry[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  provider?: string;
  model?: string;
  /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[];
  /** Session-pinned embedded harness id. Prevents runtime hot-switching. */
  agentHarnessId?: string;
  /** Explicit runtime override selected for this turn. Unlike agentHarnessId, this may force OpenClaw. */
  agentHarnessRuntimeOverride?: string;
  authProfileId?: string;
  /** Whether authProfileId came from user selection or automatic routing. */
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  /** Low-latency hint that can reduce reasoning/context work when supported. */
  fastMode?: boolean;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  toolProgressDetail?: ToolProgressDetailMode;
  /** If true, suppress tool error warning payloads for this run (including mutating tools). */
  suppressToolErrorWarnings?: boolean | (() => boolean | undefined);
  /** Bootstrap context mode for workspace file injection. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Run kind hint for context mode behavior. */
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
  /** Seen bootstrap truncation warning signatures for this session (once mode dedupe). */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Last shown bootstrap truncation warning signature for this session. */
  bootstrapPromptWarningSignature?: string;
  execOverrides?: Pick<
    ExecToolDefaults,
    "host" | "security" | "ask" | "node" | "notifyOnExit" | "notifyOnExitEmptySuccess"
  >;
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
  /** Caller abort signal for user-visible cancellation, distinct from internal timeout aborts. */
  abortSignal?: AbortSignal;
  /** Fired once the embedded run has crossed from queued/setup into execution. */
  onExecutionStarted?: () => void;
  /** Fine-grained phase callback used by UI/lifecycle diagnostics. */
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
  /** Coarse progress callback used for provider/model failover and long-running stages. */
  onRunProgress?: (info: {
    reason: string;
    provider?: string;
    model?: string;
    backend?: string;
  }) => void;
  replyOperation?: ReplyOperation;
  /** Gate for emitting tool result reply payloads after caller state changes. */
  shouldEmitToolResult?: () => boolean;
  /** Gate for streaming raw tool output after caller state changes. */
  shouldEmitToolOutput?: () => boolean;
  /** Streaming partial reply callback; may perform async channel delivery. */
  onPartialReply?: (payload: PartialReplyPayload) => void | Promise<void>;
  /** Called when assistant text emission starts for this turn. */
  onAssistantMessageStart?: () => void | Promise<void>;
  /** Block-based reply callback for transports that need chunked assistant payloads. */
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  /** Flush callback for pending block replies after stream boundaries. */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  /** Reasoning stream callback for providers that expose separate reasoning text/media. */
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoningSnapshot?: boolean;
  }) => void | Promise<void>;
  /** Called after a provider-specific reasoning stream closes. */
  onReasoningEnd?: () => void | Promise<void>;
  /** Tool-result reply callback after formatting and policy filtering. */
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  /** Raw agent event callback for gateway/session subscribers. */
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
  /** Additional system prompt text appended by trusted callers for this run only. */
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPromptMode?: SilentReplyPromptMode;
  /** Internal events already associated with the run before model execution. */
  internalEvents?: AgentInternalEvent[];
  /** Provenance for the user input that created this run. */
  inputProvenance?: InputProvenance;
  /** Provider stream options forwarded after runtime normalization. */
  streamParams?: AgentStreamParams;
  /** Owner phone numbers used for channel auth decisions; keep out of diagnostics. */
  ownerNumbers?: string[];
  /** Enforce final-answer tag behavior for prompt profiles that require it. */
  enforceFinalTag?: boolean;
  /** Caller expects no visible reply unless the model explicitly has one. */
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
  /** Avoid persisting assistant-only transcript rows created for internal repair. */
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  /** Avoid persisting assistant error rows when the caller owns error reporting. */
  suppressAssistantErrorPersistence?: boolean;
  /** Recorder for durable user-turn transcript writes before model execution. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  /** Hook after durable user message persistence, used to link session-side state. */
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  /** Hook after assistant error persistence, used for recovery metadata updates. */
  onAssistantErrorMessagePersisted?: (
    message: Extract<AgentMessage, { role: "assistant" }>,
  ) => void;
  /**
   * Dispose bundled MCP runtimes when the overall run ends instead of preserving
   * the session-scoped cache. Intended for one-shot local CLI runs that must
   * exit promptly after emitting the final JSON result.
   */
  cleanupBundleMcpOnRunEnd?: boolean;
};
