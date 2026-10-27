import type { AgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import type { AgentItemEventData } from "../infra/agent-activity-events.js";
import type { AssistantMessage } from "../llm/types.js";
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import type { LiveEditDiffProgressState } from "./embedded-agent-live-edit-diff.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { createEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import type { EmbeddedRunLivenessState } from "./embedded-agent-runner/types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import {
  createAssistantStreamBlockState,
  createThinkingTagStreamState,
  type createAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";
import { collectAgentInternalEventMedia } from "./internal-events.js";
import type { McpConnectAction } from "./mcp-connect-action.js";
import type { McpAppChannelView } from "./mcp-ui-resource.js";
import type { ReplyDeliveryState } from "./reply-completion.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";

/** Per-tool metadata tracked between tool start/update/end events. */
export type ToolCallSummary = {
  meta?: string;
  commandBearing: boolean;
  instanceReplaySafe: boolean;
  replaySafe: boolean;
  ownerKey?: string;
};

export type ExecLiveItemMetadata = {
  name: string;
  meta?: string;
  commandBearing?: boolean;
  hideFromChannelProgress: boolean;
};

export type StreamingReplyResolver = (params: {
  evtType: "text_delta" | "text_start" | "text_end";
  next: string;
  previousText: string;
  previousCleaned: string;
  visibleDelta: string;
  appendDelta: string | null;
  parsedStreamDirectives: ReplyDirectiveParseResult | null;
  previousAudioDirectiveCount: number;
  rawDirectiveSource?: string;
  rawDirectiveDelta?: string;
}) => {
  text: string;
  delta: string;
  replace: boolean;
  hasText: boolean;
  replyDirectives: ReplyDirectiveParseResult | null;
  audioDirectiveCount: number;
};

/** Incremental tag and Markdown parsing state, owned by one stream lane. */
export type StreamBlockState = {
  reasoningDepth: number;
  final: boolean;
  inlineCode?: InlineCodeState;
  fence?: FenceScanState;
  reasoningInlineCode?: InlineCodeState;
  reasoningFence?: FenceScanState;
  reasoningPendingFenceFragment?: string;
  finalInlineCode?: InlineCodeState;
  finalFence?: FenceScanState;
  pendingFenceFragment?: string;
  pendingTagFragment?: string;
};

/** A response-ending answer and the message index its reply payload belongs to. */
export type CompletedAssistantAnswer = { assistant: AssistantMessage; messageIndex: number };

/** Mutable subscription state shared by embedded-agent event handlers. */
export class EmbeddedAgentSubscribeState {
  assistantTexts: string[] = [];
  answerSegments: Array<{
    textEnd: number;
    messageEnd: number;
    finalMessageStart: number;
    lastAssistant: AssistantMessage;
    keptAnswer?: CompletedAssistantAnswer;
    sourceReplyDeliveryState?: ReplyDeliveryState;
  }> = [];
  /** Latest response-ending answer to the current input. */
  declare inputAnswer?: CompletedAssistantAnswer;
  /** That answer while the latest assistant message added no reply of its own: the turn's reply. */
  declare keptAnswer?: CompletedAssistantAnswer;
  toolMetas: Array<
    EmbeddedRunAttemptResult["toolMetas"][number] & {
      parentToolCallId?: string;
      activity?: AgentItemEventData;
    }
  > = [];
  acceptedSessionSpawns: AcceptedSessionSpawn[] = [];
  toolMetaById = new Map<string, ToolCallSummary>();
  toolSummaryById = new Set<string>();
  declare execLiveUpdateStateById?: Map<
    string,
    { lastEmittedAtMs: number; itemMetadata: ExecLiveItemMetadata }
  >;
  liveEditDiffStateById = new Map<string, LiveEditDiffProgressState>();
  itemActiveIds = new Set<string>();
  itemStartedCount = 0;
  itemCompletedCount = 0;
  /**
   * Completed assistant round trips in this attempt. Survives compaction-retry
   * presentation resets, matching how usage totals keep counting model calls.
   */
  assistantTurnCount = 0;
  lastToolError?: ToolErrorSummary = undefined;
  declare latestMcpAppChannelView?: McpAppChannelView;
  declare latestMcpConnectAction?: McpConnectAction;

  blockReplyBreak: "text_end" | "message_end";
  reasoningMode: ReasoningLevel;
  includeReasoning: boolean;
  shouldEmitPartialReplies: boolean;
  streamReasoning: boolean;

  deltaBuffer = "";
  /** Raw text received for the current native block, independent of snapshot separators. */
  streamBlockText = "";
  streamBlockFinal = false;
  /** Native source boundary from which the prepared block chunker's frame begins. */
  blockReplyScopeStart: { contentIndex: number; itemId?: string; after?: boolean } | undefined =
    undefined;
  /** Scanner state shares deltaBuffer's lifecycle so each provider byte is parsed once. */
  thinkingTagStream = createThinkingTagStreamState();
  /**
   * True while the buffered stream text belongs to an explicit commentary
   * item (e.g. the Responses API "commentary" phase). Commentary is routed to
   * a separate lane by the normal stream path, so the run-budget timeout
   * flush must skip it too: flushing the raw deltaBuffer without this marker
   * would publish reasoning/commentary bytes as assistant text.
   */
  deltaBufferIsCommentary = false;
  declare nextCommentaryAt?: number;
  /** Whether timeout settlement committed visible text for this message. */
  hasFlushedPartialText = false;
  partialBlockState: StreamBlockState & { inlineCode: InlineCodeState } =
    createAssistantStreamBlockState();
  /** Accepted audio occurrences in the current partial-directive snapshot. */
  lastAssistantAudioDirectiveCount = 0;
  assistantStream?: {
    raw: string;
    text: string;
    projection?: {
      kind: "raw" | "delivery" | "final";
      projector: ReturnType<typeof createAssistantVisibleStreamText>;
      resolveReply: StreamingReplyResolver;
    };
  } = undefined;
  lastStreamedReasoning?: string = undefined;
  lastBlockReplyText?: string = undefined;
  lastDeliveredBlockReplyText?: string = undefined;
  deferBlockReplyDelivery: boolean;
  deferredBlockReplies: BlockReplyPayload[] = [];
  toolExecutionSinceLastBlockReply = false;
  reasoningStreamOpen = false;
  assistantMessageIndex = 0;
  /** Physical message boundary; assistantMessageIndex also advances between content blocks. */
  assistantMessageStartIndex = 0;
  lastAssistantStreamContentIndex?: number = undefined;
  lastAssistantStreamItemId?: string = undefined;
  lastAssistantTextMessageIndex = -1;
  lastAssistantTextContentIndex?: number = undefined;
  lastAssistantTextItemId?: string = undefined;
  lastAssistantTextNormalized?: string = undefined;
  lastAssistantTextTrimmed?: string = undefined;
  assistantTextBaseline = 0;
  suppressBlockChunks = false; // Avoid late chunk inserts after final text merge.
  lastReasoningSent?: string = undefined;

  compactionInFlight = false;
  lastCompactionTokensAfter?: number = undefined;
  pendingCompactionRetry = 0;
  unsubscribed = false;
  replayState: ReturnType<typeof createEmbeddedRunReplayState>;
  livenessState?: EmbeddedRunLivenessState = "working";
  declare terminalStopReason?: string;
  declare yielded?: boolean;
  declare timeoutPhase?: AgentRunTimeoutPhase;
  declare providerStarted?: boolean;
  declare terminalAborted?: boolean;
  hadDeterministicSideEffect?: boolean = false;
  pendingEventChain: Promise<void> | null = null;

  messagingToolSentTexts: string[] = [];
  messagingToolSentTextsNormalized: string[] = [];
  currentSourceMessagingToolSentTextsNormalized: string[] = [];
  currentSourceMessagingToolHeldPartial?: string = undefined;
  messagingToolSentTargets: MessagingToolSend[] = [];
  messagingToolSentMediaUrls: string[] = [];
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[] = [];
  messageToolOnlySourceReplyDelivered = false;
  declare sourceReplyDelivered?: true;
  sourceReplyDeliveryState?: ReplyDeliveryState = "missing";
  /** Whether the current provider turn's finished tools were only complete source progress. */
  declare turnToolsOnlySourceProgress?: boolean;
  /** The same fact for the latest provider turn that finished any tool. */
  declare lastToolTurnOnlySourceProgress?: boolean;
  successfulCronAdds = 0;
  pendingToolMediaUrls: string[];
  pendingToolMediaAttachments?: ReplyMediaAttachment[];
  /** Per-URL local-media trust; keys are normalized pending media URLs. */
  pendingToolMediaTrustByUrl: Map<string, boolean>;
  /** Exact media URLs whose owning built-in tool contract requires source delivery. */
  toolAutoDeliveryMediaUrls = new Set<string>();
  pendingToolAudioAsVoice = false;
  pendingToolMediaDeliveryFailed = false;
  hasToolMediaBlockReply = false;
  visibleBlockReplyCount = 0;
  /** Media selection belongs to message_end; only voice/reply intent waits for a block. */
  pendingAssistantReplyDirectives?: Pick<
    BlockReplyPayload,
    "audioAsVoice" | "replyToId" | "replyToTag" | "replyToCurrent"
  > & { audioDirectiveStart?: number } = undefined;
  deterministicApprovalPromptPending = false;
  deterministicApprovalPromptSent = false;
  declare lastAssistant?: AssistantMessage;

  // Terminal results outlive the subscription; retain only its recorded facts.
  setTerminalLifecycleMeta(meta: {
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
    stopReason?: string;
    yielded?: boolean;
    timeoutPhase?: AgentRunTimeoutPhase;
    providerStarted?: boolean;
    aborted?: boolean;
  }): void {
    if (meta.replayInvalid !== undefined) {
      this.replayState = { ...this.replayState, replayInvalid: meta.replayInvalid };
    }
    if (meta.livenessState) {
      this.livenessState = meta.livenessState;
    }
    if (meta.stopReason !== undefined) {
      this.terminalStopReason = meta.stopReason;
    }
    if (meta.yielded !== undefined) {
      this.yielded = meta.yielded;
    }
    if (meta.timeoutPhase) {
      this.timeoutPhase = meta.timeoutPhase;
    }
    if (meta.providerStarted !== undefined) {
      this.providerStarted = meta.providerStarted;
    }
    if (meta.aborted !== undefined) {
      this.terminalAborted = meta.aborted;
    }
  }

  constructor(
    params: Pick<
      SubscribeEmbeddedAgentSessionParams,
      | "reasoningMode"
      | "thinkingLevel"
      | "internalEvents"
      | "blockReplyBreak"
      | "onBlockReply"
      | "streamReasoningInNonStreamModes"
      | "onReasoningStream"
      | "onBeforeTerminalDelivery"
      | "deferTerminalDelivery"
      | "initialReplayState"
    >,
  ) {
    const reasoningMode = params.reasoningMode ?? "off";
    const canShowReasoning = params.thinkingLevel !== "off";
    const initialPendingToolMedia = collectAgentInternalEventMedia(params.internalEvents);
    this.blockReplyBreak = params.blockReplyBreak ?? "text_end";
    this.reasoningMode = reasoningMode;
    this.includeReasoning = reasoningMode === "on" && canShowReasoning;
    this.shouldEmitPartialReplies = !(reasoningMode === "on" && !params.onBlockReply);
    this.streamReasoning =
      (params.streamReasoningInNonStreamModes === true
        ? reasoningMode !== "on"
        : reasoningMode === "stream") &&
      canShowReasoning &&
      typeof params.onReasoningStream === "function";
    this.deferBlockReplyDelivery =
      typeof params.onBeforeTerminalDelivery === "function" &&
      params.deferTerminalDelivery !== false;
    this.replayState = createEmbeddedRunReplayState(params.initialReplayState);
    this.pendingToolMediaUrls = initialPendingToolMedia.mediaUrls;
    this.pendingToolMediaAttachments = initialPendingToolMedia.attachments;
    this.pendingToolMediaTrustByUrl = initialPendingToolMedia.trustByUrl;
  }
}
