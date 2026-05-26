import { ImageContent } from "@earendil-works/pi-ai";

//#region src/media/prompt-image-order.d.ts
type PromptImageOrderEntry = "inline" | "offloaded";
//#endregion
//#region src/interactive/payload.d.ts
type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";
/** Visual tone for a portable message presentation. */
type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";
/** Button style hint for renderers that support styled actions. */
type MessagePresentationButtonStyle = InteractiveButtonStyle;
/** Portable action control rendered as a button or link by channel adapters. */
type MessagePresentationButton = {
  /** User-visible button label. */label: string; /** Callback command or opaque value sent when the button is pressed. */
  value?: string; /** External URL opened by the button instead of sending a callback value. */
  url?: string; /** Telegram-style web app launch target. */
  webApp?: {
    url: string;
  };
  /**
   * @deprecated Use webApp. The snake_case alias is accepted for legacy JSON payloads only.
   */
  web_app?: {
    url: string;
  }; /** Higher-priority buttons are kept first when channel limits require truncation. */
  priority?: number; /** Disable the button when the target channel supports disabled controls. */
  disabled?: boolean; /** Keep this action available after a successful interaction when the target channel supports it. */
  reusable?: boolean; /** Optional visual style hint; unsupported channels ignore or normalize it. */
  style?: InteractiveButtonStyle;
};
/** Portable select/menu option. */
type MessagePresentationOption = {
  /** User-visible option label. */label: string; /** Callback command or opaque value sent when the option is selected. */
  value: string;
};
/**
 * @deprecated Use MessagePresentationButton.
 */
type InteractiveReplyButton = MessagePresentationButton;
/**
 * @deprecated Use MessagePresentationOption.
 */
type InteractiveReplyOption = MessagePresentationOption;
/**
 * @deprecated Use MessagePresentationTextBlock.
 */
type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};
/**
 * @deprecated Use MessagePresentationButtonsBlock.
 */
type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};
/**
 * @deprecated Use MessagePresentationSelectBlock.
 */
type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};
/**
 * @deprecated Use MessagePresentationBlock.
 */
type InteractiveReplyBlock = InteractiveReplyTextBlock | InteractiveReplyButtonsBlock | InteractiveReplySelectBlock;
/**
 * @deprecated Use MessagePresentation.
 */
type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};
type MessagePresentationTextBlock = {
  type: "text"; /** Primary markdown-ish text rendered in the message body. */
  text: string;
};
type MessagePresentationContextBlock = {
  type: "context"; /** Lower-emphasis contextual text, or normal text on channels without context support. */
  text: string;
};
type MessagePresentationDividerBlock = {
  type: "divider";
};
type MessagePresentationButtonsBlock = {
  type: "buttons"; /** Button row candidates; core may split or truncate them for channel limits. */
  buttons: MessagePresentationButton[];
};
type MessagePresentationSelectBlock = {
  type: "select"; /** Optional prompt shown above or inside the select control. */
  placeholder?: string; /** Menu options; core may truncate them for channel limits. */
  options: MessagePresentationOption[];
};
type MessagePresentationInteractiveBlock = MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
type MessagePresentationBlock = MessagePresentationTextBlock | MessagePresentationContextBlock | MessagePresentationDividerBlock | MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
type MessagePresentation = {
  /** Optional short heading rendered before blocks when the channel supports it. */title?: string; /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: MessagePresentationTone; /** Ordered portable blocks rendered or downgraded by the target channel adapter. */
  blocks: MessagePresentationBlock[];
};
type ReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};
type ReplyPayloadDelivery = {
  pin?: boolean | ReplyPayloadDeliveryPin;
};
/**
 * @deprecated Use normalizeMessagePresentation.
 */
declare function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined;
declare function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined;
/**
 * @deprecated Use hasMessagePresentationBlocks.
 */
declare function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply;
declare function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation;
/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
declare function presentationToInteractiveReply(presentation: MessagePresentation): InteractiveReply | undefined;
declare function isMessagePresentationInteractiveBlock(block: MessagePresentationBlock): block is MessagePresentationInteractiveBlock;
/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
declare function presentationToInteractiveControlsReply(presentation: MessagePresentation): InteractiveReply | undefined;
/**
 * @deprecated Legacy bridge for old InteractiveReply payloads. New producers should send MessagePresentation.
 */
declare function interactiveReplyToPresentation(interactive: InteractiveReply): MessagePresentation | undefined;
declare function renderMessagePresentationFallbackText(params: {
  presentation?: MessagePresentation;
  emptyFallback?: string | null;
  text?: string | null;
}): string;
declare function hasReplyChannelData(value: unknown): value is Record<string, unknown>;
declare function hasReplyContent(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: ReadonlyArray<string | null | undefined>;
  interactive?: unknown;
  presentation?: unknown;
  hasChannelData?: boolean;
  extraContent?: boolean;
}): boolean;
/**
 * @deprecated Use renderMessagePresentationFallbackText with MessagePresentation.
 */
declare function resolveInteractiveTextFallback(params: {
  text?: string;
  interactive?: InteractiveReply;
}): string | undefined;
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
  /**
   * Marks a TTS media payload as supplemental audio for assistant text that is
   * already visible through streaming or transcript projection.
   */
  ttsSupplement?: ReplyPayloadTtsSupplement;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean; /** Marks this payload as a model-fallback transition/recovery notice. */
  isFallbackNotice?: boolean; /** Marks this payload as transient status, not assistant answer content. */
  isStatusNotice?: boolean; /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};
type ReplyPayloadTtsSupplement = {
  spokenText: string;
  visibleTextAlreadyDelivered?: boolean;
};
declare function getReplyPayloadTtsSupplement(payload: Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "ttsSupplement">): ReplyPayloadTtsSupplement | undefined;
declare function isReplyPayloadTtsSupplement(payload: Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "ttsSupplement">): boolean;
declare function markReplyPayloadAsTtsSupplement<T extends ReplyPayload>(payload: T, spokenText?: string, options?: {
  visibleTextAlreadyDelivered?: boolean;
}): T;
declare function buildTtsSupplementMediaPayload(payload: ReplyPayload): ReplyPayload;
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
type QueuedReplyDeliveryCorrelation = {
  begin: () => (() => void) | void;
};
type QueuedReplyLifecycle = {
  onEnqueued?: () => void;
  onComplete?: () => void;
};
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
   * the source conversation. `message_tool_only` prefers message-tool visible
   * delivery and keeps normal final text, block output, and preview output
   * private unless dispatch explicitly marks a source reply as deliverable.
   */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode; /** Starts delivery tracking when this turn later drains as a queued followup. */
  queuedDeliveryCorrelations?: QueuedReplyDeliveryCorrelation[]; /** Tracks ownership transfer when this turn later drains as a queued followup. */
  queuedFollowupLifecycle?: QueuedReplyLifecycle; /** Allow channel-owned progress UI while final/source reply delivery remains message-tool-only. */
  allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
  disableBlockStreaming?: boolean; /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number; /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[]; /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: {
    value: boolean;
  }; /** Override agent timeout in seconds (0 = no timeout). Threads through to resolveAgentTimeoutMs. */
  timeoutOverrideSeconds?: number; /** Capability-checked one-turn model override for inline image input. */
  modelOverride?: string; /** Capability-checked runtime fallbacks for the one-turn image model override. */
  modelOverrideFallbacks?: string[];
};
//#endregion
export { MessagePresentationTextBlock as A, normalizeInteractiveReply as B, MessagePresentationButtonStyle as C, MessagePresentationInteractiveBlock as D, MessagePresentationDividerBlock as E, hasMessagePresentationBlocks as F, resolveInteractiveTextFallback as G, presentationToInteractiveControlsReply as H, hasReplyChannelData as I, PromptImageOrderEntry as K, hasReplyContent as L, ReplyPayloadDelivery as M, ReplyPayloadDeliveryPin as N, MessagePresentationOption as O, hasInteractiveReplyBlocks as P, interactiveReplyToPresentation as R, MessagePresentationButton as S, MessagePresentationContextBlock as T, presentationToInteractiveReply as U, normalizeMessagePresentation as V, renderMessagePresentationFallbackText as W, InteractiveReplyOption as _, SourceReplyDeliveryMode as a, MessagePresentation as b, ReplyPayloadTtsSupplement as c, isReplyPayloadTtsSupplement as d, markReplyPayloadAsTtsSupplement as f, InteractiveReplyButton as g, InteractiveReplyBlock as h, ReplyThreadingPolicy as i, MessagePresentationTone as j, MessagePresentationSelectBlock as k, buildTtsSupplementMediaPayload as l, InteractiveReply as m, GetReplyOptions as n, TypingController as o, InteractiveButtonStyle as p, PartialReplyPayload as r, ReplyPayload as s, BlockReplyContext as t, getReplyPayloadTtsSupplement as u, InteractiveReplySelectBlock as v, MessagePresentationButtonsBlock as w, MessagePresentationBlock as x, InteractiveReplyTextBlock as y, isMessagePresentationInteractiveBlock as z };