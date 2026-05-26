import { b as ReplyPayloadDelivery, c as MessagePresentation, n as InteractiveReply } from "./payload-BuuA629O.js";
import { ImageContent } from "@earendil-works/pi-ai";

//#region src/media/prompt-image-order.d.ts
type PromptImageOrderEntry = "inline" | "offloaded";
//#endregion
//#region src/auto-reply/reply-payload.d.ts
type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[]; /** Internal-only trust signal for gateway webchat local media embedding. */
  trustedLocalMedia?: boolean; /** Treat media as live-only content and avoid persisting the underlying media reference. */
  sensitiveMedia?: boolean; /** Channel-agnostic rich presentation. Core degrades or asks the channel renderer to map it. */
  presentation?: MessagePresentation; /** Channel-agnostic delivery preferences, e.g. pin the sent message when supported. */
  delivery?: ReplyPayloadDelivery;
  /**
   * @deprecated Use presentation.
   *
   * Internal legacy representation used by existing approval/reply helpers during migration.
   */
  interactive?: InteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean; /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean; /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  /**
   * Text synthesized into an audio-only TTS payload. Exposed to hooks for
   * archival/search use when no visible channel text is sent.
   */
  spokenText?: string;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean; /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};
//#endregion
//#region src/auto-reply/reply/typing.d.ts
type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};
//#endregion
//#region src/auto-reply/get-reply-options.types.d.ts
type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number; /** Source assistant message index from the upstream stream, when available. */
  assistantMessageIndex?: number;
};
/** Context passed to onModelSelected callback with actual model used. */
type ModelSelectedContext = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};
type TypingPolicy = "auto" | "user_message" | "system_event" | "internal_webchat" | "heartbeat";
type ReplyThreadingPolicy = {
  /** Override implicit reply-to-current behavior for the current turn. */implicitCurrentMessage?: "default" | "allow" | "deny";
};
type SourceReplyDeliveryMode = "automatic" | "message_tool_only";
type PartialReplyPayload = Pick<ReplyPayload, "text" | "mediaUrls"> & {
  delta?: string;
  replace?: true;
};
type GetReplyOptions = {
  /** Override run id for agent events (defaults to random UUID). */runId?: string; /** Abort signal for the underlying agent run. */
  abortSignal?: AbortSignal; /** Optional inbound images (used for webchat attachments). */
  images?: ImageContent[]; /** Original inline/offloaded attachment order for inbound images. */
  imageOrder?: PromptImageOrderEntry[]; /** Notifies when an agent run actually starts (useful for webchat command handling). */
  onAgentRunStart?: (runId: string) => void;
  onReplyStart?: () => Promise<void> | void; /** Called when the typing controller cleans up (e.g., run ended with NO_REPLY). */
  onTypingCleanup?: () => void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean; /** Policy-level typing control for run classes (user/system/internal/heartbeat). */
  typingPolicy?: TypingPolicy; /** Force-disable typing indicators for this run (system/internal/cross-channel routes). */
  suppressTyping?: boolean; /** Resolved heartbeat model override (provider/model string from merged per-agent config). */
  heartbeatModelOverride?: string; /** One-shot thinking level override for this run; does not persist to the session. */
  thinkingLevelOverride?: string; /** One-shot fast-mode override for this run; does not persist to the session. */
  fastModeOverride?: boolean; /** Controls bootstrap workspace context injection (default: full). */
  bootstrapContextMode?: "full" | "lightweight"; /** If true, suppress tool error warning payloads for this run. */
  suppressToolErrorWarnings?: boolean; /** If true, run the model without OpenClaw tools for this turn. */
  disableTools?: boolean; /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean; /** If true, keep the heartbeat response tool available even under narrow tool profiles. */
  forceHeartbeatTool?: boolean;
  /**
   * If true, dispatch skips default tool/progress text messages and expects the
   * channel to surface progress via its own streaming/edit UX.
   */
  suppressDefaultToolProgressMessages?: boolean;
  onPartialReply?: (payload: PartialReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void; /** Called when a thinking/reasoning block ends. */
  onReasoningEnd?: () => Promise<void> | void; /** Called when a new assistant message starts (e.g., after tool call or thinking block). */
  onAssistantMessageStart?: () => Promise<void> | void;
  /** Called synchronously when a block reply is logically emitted, before async
   * delivery drains. Useful for channels that need to rotate preview state at
   * block boundaries without waiting for transport acks. */
  onBlockReplyQueued?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void; /** Called when a tool phase starts/updates, before summary payloads are emitted. */
  onToolStart?: (payload: {
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
    detailMode?: "explain" | "raw";
  }) => Promise<void> | void; /** Called when a concrete work item starts, updates, or completes. */
  onItemEvent?: (payload: {
    itemId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    meta?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void; /** Called when the agent emits a structured plan update. */
  onPlanUpdate?: (payload: {
    phase?: string;
    title?: string;
    explanation?: string;
    steps?: string[];
    source?: string;
  }) => Promise<void> | void; /** Called when an approval becomes pending or resolves. */
  onApprovalEvent?: (payload: {
    phase?: string;
    kind?: string;
    status?: string;
    title?: string;
    itemId?: string;
    toolCallId?: string;
    approvalId?: string;
    approvalSlug?: string;
    command?: string;
    host?: string;
    reason?: string;
    scope?: "turn" | "session";
    message?: string;
  }) => Promise<void> | void; /** Called when command output streams or completes. */
  onCommandOutput?: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    output?: string;
    status?: string;
    exitCode?: number | null;
    durationMs?: number;
    cwd?: string;
  }) => Promise<void> | void; /** Called when a patch completes with a file summary. */
  onPatchSummary?: (payload: {
    itemId?: string;
    phase?: string;
    title?: string;
    toolCallId?: string;
    name?: string;
    added?: string[];
    modified?: string[];
    deleted?: string[];
    summary?: string;
  }) => Promise<void> | void; /** Called when context auto-compaction starts (allows UX feedback during the pause). */
  onCompactionStart?: () => Promise<void> | void; /** Called when context auto-compaction completes. */
  onCompactionEnd?: () => Promise<void> | void;
  /** Called when the actual model is selected (including after fallback).
   * Use this to get model/provider/thinkLevel for responsePrefix template interpolation. */
  onModelSelected?: (ctx: ModelSelectedContext) => void;
  /**
   * Controls whether normal assistant replies are automatically delivered to
   * the source conversation. `message_tool_only` keeps final/block/preview
   * output private; visible channel output must come from the message tool.
   */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode; /** Allow channel-owned progress UI while final/source reply delivery remains message-tool-only. */
  allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
  disableBlockStreaming?: boolean; /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number; /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[]; /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: {
    value: boolean;
  }; /** Override agent timeout in seconds (0 = no timeout). Threads through to resolveAgentTimeoutMs. */
  timeoutOverrideSeconds?: number;
};
//#endregion
export { SourceReplyDeliveryMode as a, PromptImageOrderEntry as c, ReplyThreadingPolicy as i, GetReplyOptions as n, TypingController as o, PartialReplyPayload as r, ReplyPayload as s, BlockReplyContext as t };