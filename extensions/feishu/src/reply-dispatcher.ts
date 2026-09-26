import { formatReasoningMessage, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  formatChannelProgressDraftLineForEntry,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { toStringifiedError as toFeishuError } from "openclaw/plugin-sdk/error-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import type { ClawdbotConfig, OutboundIdentity, ReplyPayload, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import { shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import {
  consumeFeishuPresentationFallbackMarker,
  hasCardMarkdownTable,
  renderFeishuReplyPayload,
  cardCarriesWholeTable,
  shouldUseCard,
  withinCardTableLimit,
} from "./presentation-card.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliveryResultWithFinalization,
} from "./reply-delivery-result.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplySenders } from "./reply-senders.js";
import { getFeishuRuntime } from "./runtime.js";
import { chunkFeishuCardMarkdown, sendCardFeishu, type CardHeaderConfig } from "./send.js";
import {
  FeishuStreamingFinalizationError,
  FeishuStreamingSession,
  mergeStreamingText,
} from "./streaming-card.js";
import { createFeishuTableRouting } from "./table-routing.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

function mergeStreamingFinalText(
  previousText: string,
  nextText: string,
  appendError: boolean,
): string {
  if (!appendError || !previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(`\n\n${nextText}`)) {
    return previousText;
  }
  return `${previousText}\n\n${nextText}`;
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
const STREAMING_START_FAILURE_BACKOFF_MS = 60_000;
const NO_VISIBLE_REPLY_FALLBACK_TEXT =
  "⚠️ This reply completed without visible content. The turn may have been interrupted; please retry or ask me to recover from recent context.";

function isStreamingStartBackedOff(accountId: string, now = Date.now()): boolean {
  const backoffUntil = streamingStartBackoffUntilByAccount.get(accountId);
  if (backoffUntil === undefined) {
    return false;
  }
  if (backoffUntil <= now) {
    streamingStartBackoffUntilByAccount.delete(accountId);
    return false;
  }
  return true;
}

function rememberStreamingStartFailure(accountId: string, now = Date.now()): void {
  const backoffUntil = now + STREAMING_START_FAILURE_BACKOFF_MS;
  streamingStartBackoffUntilByAccount.set(accountId, backoffUntil);
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = resolveFeishuIdentityEmoji(identity?.emoji);
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    template: identity?.theme ?? "blue",
  };
}

/** Build a card note footer from agent identity and model context. */
function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  sendTarget: string;
  allowReasoningPreview?: boolean;
  replyToMessageId?: string;
  typingTargetMessageId?: string;
  /** When true, omit reply metadata from visible messages while keeping typing on its target. */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  accountId?: string;
  identity?: OutboundIdentity;
  mentionTargets?: MentionTarget[];
  /** Mentions required on every mention-capable text/card reply, used for bot-authored ingress. */
  requiredMentionTargets?: MentionTarget[];
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
  sessionKey?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    sendTarget,
    replyToMessageId,
    typingTargetMessageId: explicitTypingTargetMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    accountId,
    identity,
    mentionTargets,
    requiredMentionTargets,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const typingTargetMessageId = explicitTypingTargetMessageId?.trim() || replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const allowTopLevelReplyFallback =
    effectiveReplyInThread === true &&
    threadReplyMode &&
    rootId !== undefined &&
    sendReplyToMessageId !== undefined &&
    sendReplyToMessageId !== rootId;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  let typingState: TypingIndicatorState | null = null;
  // Reply text and card attribution share the same selected-model context.
  const { typingCallbacks, responsePrefix, responsePrefixContextProvider, onModelSelected } =
    createChannelMessageReplyPipeline({
      cfg,
      agentId,
      channel: "feishu",
      accountId,
      typing: {
        start: async () => {
          // Check if typing indicator is enabled (default: true)
          if (!(account.config.typingIndicator ?? true)) {
            return;
          }
          if (!typingTargetMessageId) {
            return;
          }
          // Skip typing indicator for old messages — likely replays after context
          // compaction that would flood users with stale notifications (#30418).
          const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
          if (
            messageCreateTimeMs !== undefined &&
            Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
          ) {
            return;
          }
          // Feishu reactions persist until explicitly removed, so skip keepalive
          // re-adds when a reaction already exists. Re-adding the same emoji
          // triggers a new push notification for every call (#28660).
          if (typingState?.reactionId) {
            return;
          }
          typingState = await addTypingIndicator({
            cfg,
            messageId: typingTargetMessageId,
            accountId,
            runtime: params.runtime,
          });
        },
        stop: async () => {
          if (!typingState) {
            return;
          }
          await removeTypingIndicator({
            cfg,
            state: typingState,
            accountId,
            runtime: params.runtime,
          });
          typingState = null;
        },
        onStartError: (err) =>
          logTypingFailure({
            log: (message) => params.runtime.log?.(message),
            channel: "feishu",
            action: "start",
            error: err,
          }),
        onStopError: (err) =>
          logTypingFailure({
            log: (message) => params.runtime.log?.(message),
            channel: "feishu",
            action: "stop",
            error: err,
          }),
      },
    });

  // Every lookup here describes the account that actually sends, which is the one
  // `resolveFeishuRuntimeAccount` picked above. Passing the request's raw id instead
  // skips an account-scoped limit, mode or table setting whenever the request omits
  // it and a default or sole account supplies one.
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu", account.accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: true,
  });
  // Post rendering has no native tables, so block falls back to code there. An
  // explicit off, bullets or code converts before each card path that commits it, so the
  // mode applies in auto mode, to a presentation card's own markdown, and to the text a
  // streaming card commits. Streamed reasoning shares that card, so it converts on
  // arrival and carries one representation to every flush and to the close. Partial
  const tableRouting = createFeishuTableRouting({
    convertMarkdownTables: core.channel.text.convertMarkdownTables,
    tableMode,
  });
  const { nativeTables, postTableMode, renderTables, previewReasoningText } = tableRouting;
  const { tableNeedsPostPath, answerTableNeedsPostPath } = tableRouting;
  const renderMode = account.config?.renderMode ?? "auto";
  // Streaming cards cannot attach native mention recipients. Bot-authored ingress
  // therefore uses normal cards/posts so every emitted unit reaches the peer bot.
  const streamingEnabled =
    !requiredMentionTargets?.length &&
    resolveChannelPreviewStreamMode(account.config, "partial") !== "off" &&
    renderMode !== "raw";
  const hookRunner = getGlobalHookRunner();
  const modifyingHooksRegistered =
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false);
  // A preview exists before modifying hooks accept the logical payload, so suppress all eager
  // CardKit activity whenever either hook could rewrite or cancel the eventual send.
  const previewStreamingEnabled = streamingEnabled && !modifyingHooksRegistered;
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
  const coreBlockStreamingEnabled = blockStreamingEnabled === true;
  const reasoningPreviewEnabled = previewStreamingEnabled && params.allowReasoningPreview === true;

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  let statusLine = "";
  let snapshotBaseText = "";
  let lastSnapshotTextLength = 0;
  // Partial previews are replaceable; only committed final text may precede an error notice.
  let hasStreamingFinalText = false;
  const deliveredFinalTexts = new Set<string>();
  const blockPostDeliveries = new Map<string, Promise<FeishuReplyDeliveryResult>>();
  type StreamingDisposition = "closed" | "discarded";
  type StreamingCloseOutcome = {
    disposition: StreamingDisposition;
    result: FeishuReplyDeliveryResult;
    generation?: number;
    error?: unknown;
  };
  type ClosedStreamingSettlement = StreamingCloseOutcome & {
    content: string;
    contentClaimed?: boolean;
  };
  const closedStreamingSettlements = new Map<number, ClosedStreamingSettlement>();
  let sentIndependentBlockText = false;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingGeneration = 0;
  let activeStreamingGeneration: number | undefined;
  let inFlightStreamingClose:
    | {
        session: FeishuStreamingSession;
        generation: number;
        content: string;
        disposition: StreamingDisposition;
        promise: Promise<StreamingCloseOutcome>;
      }
    | undefined;
  let visibleReplySent = false;
  type ReplyOutcome =
    | { kind: "skipped"; reason: string; assistantMessageIndex?: number }
    | { kind: "suppressed"; reason: string }
    | { kind: "failed" };
  let replyOutcome: ReplyOutcome | undefined;
  let idleSideEffectsPromise: Promise<void> = Promise.resolve();
  let activeIdleSideEffectsPromise: Promise<void> | null = null;
  let idleRequestedForReply = false;
  let replyLifecycleStateInitialized = false;
  type PendingStreamingDelivery = {
    result: FeishuReplyDeliveryResult;
    infoKind?: string;
    streamingGeneration?: number;
    resolve: (result: FeishuReplyDeliveryResult) => void;
    reject: (error: unknown) => void;
  };
  const pendingStreamingDeliveries: PendingStreamingDelivery[] = [];
  type StreamTextUpdateMode = "snapshot" | "delta";

  const markVisibleReplySent = () => {
    visibleReplySent = true;
  };

  // A line the renderer has to recognize as structure. A table row is any line
  // carrying a cell separator, not only one that opens with a pipe, because the
  // shapes this change taught the card parser include pipe-less, leading-pipe-only
  // and trailing-pipe-only tables, and a blockquoted table carries its prefix first.
  // Erring toward leaving a line plain costs an italic; erring the other way
  // destroys a delimiter row and with it the table.
  // A quoted table keeps its prefix through conversion, so the fence and the list marker
  // the mode produces arrive behind one, and a pattern anchored at the line start reads
  // them as prose and underscores them away.
  const reasoningFenceLine = /^\s*(?:>\s*)*```/u;
  const isReasoningStructureLine = (line: string): boolean =>
    reasoningFenceLine.test(line) ||
    line.includes("|") ||
    /^\s*(?:>\s*)*(?:[-*+\u2022]\s|\d+[.)]\s)/u.test(line) ||
    /^\s*>?\s*:?-{3,}:?\s*$/u.test(line);

  // The shared formatter wraps every non-empty line in underscores, which suits prose
  // and destroys every shape the table mode produces. Underscores inside a fence are
  // literal, an underscored delimiter row is no longer a table, and an underscored
  // marker is no longer a list item. Italicize prose only and leave structure alone.
  // Text with no structure keeps going through the shared formatter untouched, and the
  // plain label stays so existing detection keeps working.
  const formatReasoningPreservingStructure = (text: string): string => {
    const trimmed = text.trim();
    const lines = trimmed.split("\n");
    if (!trimmed || !lines.some(isReasoningStructureLine)) {
      return formatReasoningMessage(text);
    }
    let insideFence = false;
    const formatted = lines.map((line) => {
      if (reasoningFenceLine.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      return insideFence || !line || isReasoningStructureLine(line) ? line : `_${line}_`;
    });
    return `Thinking\n\n${formatted.join("\n")}`;
  };

  // The reasoning stream stores its text already italicised, so the shape a card
  // finally sees is this stripped form rather than what is held. Anything asking what
  // the card will draw has to ask about this.
  const plainReasoningText = (thinking: string): string =>
    thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "").replace(/^_(.*)_$/gm, "$1");

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) {
      return "";
    }
    const lines = plainReasoningText(thinking)
      .split("\n")
      .map((line) => `> ${line}`);
    return `> 💭 **Thinking**\n${lines.join("\n")}`;
  };

  const buildCombinedStreamText = (thinking: string, answer: string): string => {
    const parts: string[] = [];
    if (thinking) {
      parts.push(formatReasoningPrefix(thinking));
    }
    if (thinking && answer) {
      parts.push("\n\n---\n\n");
    }
    if (answer) {
      parts.push(answer);
    }
    if (statusLine) {
      parts.push(parts.length > 0 ? `\n\n${statusLine}` : statusLine);
    }
    return parts.join("");
  };

  const flushStreamingCardUpdate = (combined: string) => {
    const session = streaming;
    const generation = activeStreamingGeneration;
    const startPromise = streamingStartPromise;
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (startPromise) {
        await startPromise;
      }
      // Updates queued before close owns the captured session; updates queued after the
      // generation is sealed have no owner and cannot race provider finalization.
      if (generation !== undefined && session?.isActive()) {
        await session.update(combined);
      }
    });
  };

  // `streamText` stays authored so snapshots and mirrored blocks compare and merge
  // one representation. The projection belongs here, at display, for a preview
  // exactly as much as for a settled answer: a card that shows a native table
  // while generating and the configured form at close has told two stories.
  const streamDisplayText = () => renderTables(streamText);
  // Once the answer carries a shape a card drops rows from, or one whose projection has
  // outgrown the limit a single streamed card is held to, the close routes the whole
  // message to a post and the preview is discarded. Updating it in the meantime would
  // spend the generation on a card the close throws away, so the preview stands down and
  // the text keeps accumulating for the post that settles it. Standing down is not the
  // same as having nothing to show: an answer that has not started yet still lets a
  // reasoning or status update through.
  // The card carries the reasoning wrapped and set beside the answer, so a conversion is kept
  // only while the message that carries it stays inside the limit the settled answer is held
  // to. Otherwise the reasoning goes as authored, which is what it would have been anyway.
  const previewReasoningMessage = (authored: string): string => {
    const converted = previewReasoningText(authored);
    const wrapped = formatReasoningMessage(converted);
    if (converted === authored) {
      return wrapped;
    }
    const sent = buildCombinedStreamText(wrapped, streamDisplayText());
    return sent.length > textChunkLimit ? formatReasoningMessage(authored) : wrapped;
  };

  const previewAnswerText = (): string | undefined => {
    if (answerTableNeedsPostPath(streamText)) {
      return undefined;
    }
    const display = streamDisplayText();
    // Only the converted form answers to this limit, and it answers for the message the card
    // actually carries: the reasoning wrapped beside it, not the answer alone. Text the author
    // wrote long is not this branch's doing and streams the way it always has.
    return display !== streamText &&
      buildCombinedStreamText(reasoningText, display).length > textChunkLimit
      ? undefined
      : display;
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
    },
  ) => {
    if (!nextText) {
      return;
    }
    // Answer snapshots and mirrored blocks share authored text until display. Both arrival
    // orders must compare and merge that representation, never a rendered table.
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    if (mode === "delta") {
      streamText = `${streamText}${nextText}`;
    } else {
      const currentSnapshotText = snapshotBaseText
        ? streamText.slice(snapshotBaseText.length)
        : streamText;
      const startsNewSnapshotBlock =
        lastSnapshotTextLength >= 20 &&
        nextText.length < lastSnapshotTextLength * 0.5 &&
        !currentSnapshotText.includes(nextText);
      if (startsNewSnapshotBlock) {
        snapshotBaseText = streamText;
        streamText = `${snapshotBaseText}${nextText}`;
      } else {
        streamText = `${snapshotBaseText}${mergeStreamingText(currentSnapshotText, nextText)}`;
      }
      lastSnapshotTextLength = nextText.length;
    }
    const answerPreview = previewAnswerText();
    if (answerPreview !== undefined) {
      flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, answerPreview));
    }
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) {
      return;
    }
    reasoningText = nextThinking;
    const answerPreview = previewAnswerText();
    if (answerPreview !== undefined) {
      flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, answerPreview));
    }
  };

  const startStreaming = () => {
    if (
      !streamingEnabled ||
      streamingStartPromise ||
      streaming ||
      isStreamingStartBackedOff(account.accountId)
    ) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? {
              appId: account.appId,
              appSecret: account.appSecret,
              domain: account.domain,
              httpTimeoutMs: resolveConfiguredHttpTimeoutMs(account),
            }
          : null;
      if (!creds) {
        return;
      }

      const session = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      const generation = ++streamingGeneration;
      streaming = session;
      activeStreamingGeneration = generation;
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
        const streamingTarget = sendTarget
          .replace(/^(feishu|lark):/i, "")
          .replace(/^(chat|user|group|dm|open_id):/i, "")
          .trim();
        await session.start(streamingTarget, resolveReceiveIdType(sendTarget), {
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
        streamingStartBackoffUntilByAccount.delete(account.accountId);
      } catch (error) {
        rememberStreamingStartFailure(account.accountId);
        params.runtime.error?.(
          `feishu[${account.accountId}]: streaming start failed; using non-streaming card fallback for ${
            STREAMING_START_FAILURE_BACKOFF_MS / 1000
          }s: ${String(error)}`,
        );
        if (streaming === session) {
          streaming = null;
          streamingStartPromise = null;
          activeStreamingGeneration = undefined;
        }
      }
    })();
  };

  const resetStreamingState = () => {
    streaming = null;
    streamingStartPromise = null;
    activeStreamingGeneration = undefined;
    partialUpdateQueue = Promise.resolve();
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    statusLine = "";
    snapshotBaseText = "";
    lastSnapshotTextLength = 0;
    hasStreamingFinalText = false;
  };

  const rememberClosedStreamingSettlement = (
    generation: number | undefined,
    content: string,
    result: FeishuReplyDeliveryResult,
    error?: unknown,
    disposition: StreamingDisposition = "closed",
  ) => {
    if (generation === undefined || (!content && disposition === "closed")) {
      return;
    }
    closedStreamingSettlements.set(generation, {
      disposition,
      result,
      content,
      ...(error === undefined ? {} : { error }),
    });
  };

  const performStreamingClose = async (
    disposition: StreamingDisposition,
  ): Promise<StreamingCloseOutcome> => {
    const streamingToClose = streaming;
    const generationToClose = activeStreamingGeneration;
    const startPromiseToClose = streamingStartPromise;
    const updateQueueToClose = partialUpdateQueue;
    const finalizedAnswerText = streamText;
    const answerText = renderTables(finalizedAnswerText);
    const finalizedReasoningText = reasoningText;
    const outcome = {
      disposition,
      ...(generationToClose === undefined ? {} : { generation: generationToClose }),
    };
    // Seal this generation before provider I/O. Deliveries arriving during close were not part
    // of its captured content and must take a new/static path instead of inheriting its receipt.
    if (generationToClose !== undefined && activeStreamingGeneration === generationToClose) {
      activeStreamingGeneration = undefined;
    }
    try {
      if (startPromiseToClose) {
        await startPromiseToClose;
      }
      await updateQueueToClose;
      let result = noVisibleFeishuReplyDelivery;
      let finalizationError: unknown;
      if (streamingToClose?.isActive()) {
        statusLine = "";
        // `tableNeedsPostPath` only fires in off mode, where the fallback below does not
        // apply, so the routing decision reads the untouched combination.
        const rawText = buildCombinedStreamText(finalizedReasoningText, answerText);
        // Committing here would put the table in a card just as surely as delivering a
        // final would, so this close drops the card and reuses a matching block
        // receipt or sends the combined text for a final to inherit.
        // Reasoning is blockquoted before it reaches the card, and a card does not draw
        // a blockquoted table, so one that is still raw here loses its rows. The preview
        // asks this question of every mode and gives way to the authored table when its own
        // conversion outgrows the limit, which is exactly the text the close then finds
        // stored, so the close asks the same question rather than only the native one:
        // block degrades to a quote-surviving list and keeps the card the answer earned,
        // and the other modes take their configured shape. What a mode already converted
        // carries no table for this to find, so nothing is converted twice. A projection
        // that outgrows the limit falls to the post path below, where the rows stay
        // readable: that path converts for its own target and keeps them as authored when a
        // quoted fence could not survive its cut.
        const plainReasoning = plainReasoningText(finalizedReasoningText);
        const projectedReasoning = hasCardMarkdownTable(plainReasoning)
          ? previewReasoningText(plainReasoning)
          : undefined;
        // The body a card close would write, which is what the limit has to be asked about.
        const cardText =
          projectedReasoning === undefined
            ? rawText
            : buildCombinedStreamText(projectedReasoning, answerText);
        const authoredCloseText = buildCombinedStreamText(
          finalizedReasoningText,
          finalizedAnswerText,
        );
        // A close writes the whole projection in one go and cannot cut it into several, so a
        // conversion past the limit the settled answer is held to takes the post path here
        // for the same reason the preview stands down for it. The card carries the reasoning
        // wrapped and set beside the answer, so the limit answers for that whole body rather
        // than for either half: two conversions that each fit it still write a card past it.
        // Text the author wrote long is no conversion's doing and closes the way it always
        // has, which is why the projection has to differ from the authored combination.
        const closeProjectionExceedsLimit =
          cardText !== authoredCloseText && cardText.length > textChunkLimit;
        const closeNeedsPost =
          disposition === "closed" &&
          (tableNeedsPostPath(rawText) ||
            answerTableNeedsPostPath(answerText) ||
            closeProjectionExceedsLimit);
        const text = closeNeedsPost ? rawText : cardText;
        let closed;
        try {
          if (disposition === "discarded" || closeNeedsPost) {
            closed = await streamingToClose.discard();
          } else {
            const finalNote = resolveCardNote(agentId, identity, responsePrefixContextProvider());
            closed = await streamingToClose.closeWithResult(text, { note: finalNote });
          }
        } catch (error: unknown) {
          if (!(error instanceof FeishuStreamingFinalizationError)) {
            throw error;
          }
          closed = error.result;
          finalizationError = error;
        }
        result = createFeishuReplyDeliveryResult({
          results: [closed],
          visibleReplySent: closed.visibleReplySent,
          content: closed.content,
          kind: "card",
        });
        // A failed removal can leave the card visible, so only a clean discard hands
        // the text to a post instead.
        if (closeNeedsPost && finalizationError === undefined) {
          // This post stands in for the final, and the matching final is then skipped as a
          // duplicate, so it has to carry the mentions the final would have carried. A group
          // reply that forwards mentioned users otherwise delivers the answer without
          // notifying them.
          result = await sendPostReply(
            text,
            "final",
            mentionTargets?.length ? mentionTargets : undefined,
            {
              blockAnswerText: answerText,
              authoredText: authoredCloseText,
            },
          );
        }
        if (result.visibleReplySent) {
          markVisibleReplySent();
        }
        // Only a retained final can satisfy a duplicate text payload. Requested removal
        // and actual accepted content are separate facts when provider cleanup fails.
        if (
          disposition === "closed" &&
          result.visibleReplySent &&
          finalizedAnswerText &&
          (finalizationError === undefined || result.content === text)
        ) {
          deliveredFinalTexts.add(answerText);
        }
        if (
          finalizationError instanceof FeishuStreamingFinalizationError &&
          result.visibleReplySent
        ) {
          finalizationError = createFeishuPartialReplyDeliveryError(
            finalizationError.cause ?? finalizationError,
            result,
          );
        }
      }
      if (
        disposition === "discarded" ||
        finalizationError !== undefined ||
        (result.visibleReplySent && finalizedAnswerText)
      ) {
        // Pending and media-delayed payloads still own this generation. A discarded
        // generation must never recover its obsolete prose through a new static card.
        rememberClosedStreamingSettlement(
          generationToClose,
          answerText,
          result,
          finalizationError,
          disposition,
        );
      }
      return {
        ...outcome,
        result,
        ...(finalizationError === undefined ? {} : { error: finalizationError }),
      };
    } catch (error: unknown) {
      const result = isChannelPartialDeliveryError(error)
        ? error.deliveryResult
        : noVisibleFeishuReplyDelivery;
      if (disposition === "discarded" || result.visibleReplySent) {
        rememberClosedStreamingSettlement(
          generationToClose,
          answerText,
          result,
          error,
          disposition,
        );
      }
      // A close whose post was partly accepted owns that answer from here on, so a late
      // matching final claims this settlement and rethrows the partial failure instead of
      // sending the accepted prefix a second time. This records ownership, not success:
      // the stored error still reaches the caller. A close that had nothing accepted keeps
      // no ownership and stays retryable.
      if (
        disposition === "closed" &&
        result.visibleReplySent &&
        answerText &&
        isChannelPartialDeliveryError(error)
      ) {
        deliveredFinalTexts.add(answerText);
      }
      return {
        ...outcome,
        result,
        error,
      };
    } finally {
      // A delivery overlapping this await may replace the closed session. Never clear that new
      // owner; the idle drain will close it in the next serialized iteration.
      if (streaming === streamingToClose) {
        resetStreamingState();
      }
    }
  };

  const closeStreaming = (
    disposition: StreamingDisposition = "closed",
  ): Promise<StreamingCloseOutcome> => {
    const session = streaming;
    const generation = activeStreamingGeneration;
    // Closing seals the active generation before awaiting I/O. The captured session,
    // not that cleared generation field, owns any concurrent close/discard request.
    if (session && inFlightStreamingClose?.session === session) {
      return inFlightStreamingClose.promise;
    }
    // The closing record must match the rendered final it may later inherit.
    const content = renderTables(streamText);
    const closePromise = performStreamingClose(disposition);
    if (session && generation !== undefined) {
      const closing = { session, generation, content, disposition, promise: closePromise };
      inFlightStreamingClose = closing;
      const clear = () => {
        if (inFlightStreamingClose === closing) {
          inFlightStreamingClose = undefined;
        }
      };
      void closePromise.then(clear, clear);
    }
    return closePromise;
  };

  const deferStreamingDelivery = (
    result: FeishuReplyDeliveryResult,
    infoKind?: string,
    ownerGeneration?: number,
  ): FeishuReplyDeliveryResultWithFinalization => {
    let resolveFinalization!: (result: FeishuReplyDeliveryResult) => void;
    let rejectFinalization!: (error: unknown) => void;
    const finalization = new Promise<FeishuReplyDeliveryResult>((resolve, reject) => {
      resolveFinalization = resolve;
      rejectFinalization = reject;
    });
    pendingStreamingDeliveries.push({
      result,
      ...(infoKind ? { infoKind } : {}),
      ...(ownerGeneration === undefined ? {} : { streamingGeneration: ownerGeneration }),
      resolve: resolveFinalization,
      reject: rejectFinalization,
    });
    if (idleRequestedForReply) {
      void queueIdleSideEffects().catch((error: unknown) =>
        params.runtime.error?.(
          `feishu[${account.accountId}] late reply finalization failed: ${String(error)}`,
        ),
      );
    }
    return { ...noVisibleFeishuReplyDelivery, finalization };
  };

  const discardStreamingPreview = async () => {
    if (
      streaming &&
      inFlightStreamingClose?.session === streaming &&
      inFlightStreamingClose.disposition === "closed"
    ) {
      // The earlier reply owns this sealed close and its receipt. Detach it so a
      // new payload can progress; the idle pass still settles its captured owner.
      resetStreamingState();
      return;
    }
    const outcome = await closeStreaming("discarded");
    if (outcome.error !== undefined) {
      throw toFeishuError(outcome.error);
    }
  };

  const updateStreamingStatusLine = (
    nextStatusLine: string,
    options?: { startIfNeeded?: boolean },
  ) => {
    statusLine = nextStatusLine;
    const hasStreamingSession = Boolean(streaming?.isActive() || streamingStartPromise);
    if (!hasStreamingSession && (options?.startIfNeeded === false || renderMode !== "card")) {
      return false;
    }
    startStreaming();
    // A status line still belongs on the card while the answer stands down, so this
    // update carries the status without the answer the close will send elsewhere.
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, previewAnswerText() ?? ""));
    return false;
  };

  const {
    sendChunkedTextReply,
    sendPostReply,
    sendMediaReplies,
    ensureNoVisibleReplyFallback,
    claimClosedStreamingResult,
    ensureVisibleStreamingDelivery,
  } = createFeishuReplySenders({
    core,
    cfg,
    account,
    accountId,
    sendTarget,
    sendReplyToMessageId,
    effectiveReplyInThread,
    allowTopLevelReplyFallback,
    textChunkLimit,
    chunkMode,
    postTableMode,
    requiredMentionTargets,
    markVisibleReplySent,
    deliveredFinalTexts,
    blockPostDeliveries,
    closedStreamingSettlements,
    tableNeedsPostPath,
    answerTableNeedsPostPath,
    resolveCardChrome: () => ({
      header: resolveCardHeader(agentId, identity),
      note: resolveCardNote(agentId, identity, responsePrefixContextProvider()),
    }),
    readIdleSideEffects: () => idleSideEffectsPromise,
    readVisibleReplySent: () => visibleReplySent,
    readReplyOutcome: () => replyOutcome,
    noVisibleReplyFallbackText: NO_VISIBLE_REPLY_FALLBACK_TEXT,
    log: (message: string) => params.runtime.log?.(message),
    error: (message: string) => params.runtime.error?.(message),
  });

  const markClosedStreamingContentClaimed = (generation: number | undefined): void => {
    if (generation !== undefined) {
      const settlement = closedStreamingSettlements.get(generation);
      if (settlement) {
        settlement.contentClaimed = true;
      }
    }
  };

  function queueIdleSideEffects(): Promise<void> {
    idleRequestedForReply = true;
    if (activeIdleSideEffectsPromise) {
      return activeIdleSideEffectsPromise;
    }
    const nextIdleSideEffects = idleSideEffectsPromise.then(async () => {
      try {
        do {
          // Include deliveries appended while CardKit close is in flight; every returned
          // finalization promise must be owned by this idle pass or a later loop iteration.
          const completions = pendingStreamingDeliveries.splice(0);
          const closeOutcome = await closeStreaming();
          const finalized = closeOutcome.result;
          const ownsCurrentClose = (completion: PendingStreamingDelivery) =>
            closeOutcome.generation !== undefined &&
            completion.streamingGeneration === closeOutcome.generation;
          if (completions.some((completion) => ownsCurrentClose(completion))) {
            markClosedStreamingContentClaimed(closeOutcome.generation);
          }
          for (const completion of completions) {
            const claimedSettlement = ownsCurrentClose(completion)
              ? {
                  disposition: closeOutcome.disposition,
                  result: finalized,
                  ...(closeOutcome.error === undefined ? {} : { error: closeOutcome.error }),
                }
              : claimClosedStreamingResult(
                  completion.streamingGeneration,
                  completion.result.content,
                );
            const deliveryError = claimedSettlement?.error;
            if (claimedSettlement?.disposition === "discarded") {
              const retained = mergeFeishuReplyDeliveryResults(
                [claimedSettlement.result, completion.result],
                claimedSettlement.result.content ?? "",
              );
              if (deliveryError !== undefined) {
                completion.reject(createFeishuPartialReplyDeliveryError(deliveryError, retained));
              } else {
                completion.resolve(retained);
              }
              continue;
            }
            let providerFinalized = claimedSettlement?.result;
            try {
              providerFinalized = await ensureVisibleStreamingDelivery(
                providerFinalized,
                completion.result.content,
                completion.infoKind,
              );
            } catch (fallbackError: unknown) {
              const fallbackPartial = isChannelPartialDeliveryError(fallbackError)
                ? fallbackError.deliveryResult
                : undefined;
              const fallbackCause =
                fallbackPartial && fallbackError instanceof Error
                  ? (fallbackError.cause ?? fallbackError)
                  : fallbackError;
              completion.reject(
                createFeishuPartialReplyDeliveryError(
                  deliveryError === undefined
                    ? fallbackCause
                    : new AggregateError(
                        [deliveryError, fallbackCause],
                        "Feishu streaming finalization and static fallback failed",
                      ),
                  mergeFeishuReplyDeliveryResults(
                    [
                      ...(providerFinalized ? [providerFinalized] : []),
                      ...(fallbackPartial ? [fallbackPartial] : []),
                      completion.result,
                    ],
                    fallbackPartial?.content ??
                      providerFinalized?.content ??
                      completion.result.content,
                  ),
                ),
              );
              continue;
            }
            // The finalized card is the public identity; each logical payload retains its own text.
            const settledResult = mergeFeishuReplyDeliveryResults(
              [...(providerFinalized ? [providerFinalized] : []), completion.result],
              deliveryError === undefined
                ? (completion.result.content ?? providerFinalized?.content)
                : (providerFinalized?.content ?? completion.result.content),
            );
            if (deliveryError !== undefined) {
              completion.reject(
                createFeishuPartialReplyDeliveryError(
                  isChannelPartialDeliveryError(deliveryError) && deliveryError instanceof Error
                    ? (deliveryError.cause ?? deliveryError)
                    : deliveryError instanceof FeishuStreamingFinalizationError
                      ? (deliveryError.cause ?? deliveryError)
                      : deliveryError,
                  settledResult,
                ),
              );
            } else {
              completion.resolve(settledResult);
            }
          }
          if (closeOutcome.error !== undefined) {
            throw toFeishuError(closeOutcome.error);
          }
        } while (pendingStreamingDeliveries.length > 0);
      } finally {
        typingCallbacks?.onIdle?.();
      }
    });
    activeIdleSideEffectsPromise = nextIdleSideEffects;
    idleSideEffectsPromise = nextIdleSideEffects.catch(() => {});
    const finishIdleSideEffects = () => {
      if (activeIdleSideEffectsPromise === nextIdleSideEffects) {
        activeIdleSideEffectsPromise = null;
      }
      if (pendingStreamingDeliveries.length > 0) {
        void queueIdleSideEffects().catch((error: unknown) =>
          params.runtime.error?.(
            `feishu[${account.accountId}] queued reply finalization failed: ${String(error)}`,
          ),
        );
      }
    };
    void nextIdleSideEffects.then(finishIdleSideEffects, finishIdleSideEffects);
    return nextIdleSideEffects;
  }

  const throwStreamingDeliveryFailure = async (paramsLocal: {
    error: unknown;
    content: string;
    infoKind?: string;
    ownerGeneration?: number;
  }): Promise<never> => {
    let finalized = noVisibleFeishuReplyDelivery;
    let finalizationError: unknown;
    let fallbackPartial: FeishuReplyDeliveryResult | undefined;
    let settlement: StreamingCloseOutcome | undefined = claimClosedStreamingResult(
      paramsLocal.ownerGeneration,
      paramsLocal.content,
    );
    if (
      !settlement &&
      paramsLocal.ownerGeneration !== undefined &&
      inFlightStreamingClose?.generation === paramsLocal.ownerGeneration
    ) {
      const closeOutcome = await inFlightStreamingClose.promise;
      settlement =
        claimClosedStreamingResult(paramsLocal.ownerGeneration, paramsLocal.content) ??
        closeOutcome;
    } else if (
      !settlement &&
      paramsLocal.ownerGeneration !== undefined &&
      activeStreamingGeneration === paramsLocal.ownerGeneration
    ) {
      settlement = await closeStreaming();
    }
    finalized = settlement?.result ?? finalized;
    finalizationError = settlement?.error;
    const discarded = settlement?.disposition === "discarded";
    try {
      if (!discarded) {
        finalized =
          (await ensureVisibleStreamingDelivery(
            finalized,
            paramsLocal.content,
            paramsLocal.infoKind,
          )) ?? finalized;
      }
    } catch (fallbackError: unknown) {
      fallbackPartial = isChannelPartialDeliveryError(fallbackError)
        ? fallbackError.deliveryResult
        : undefined;
      const fallbackCause =
        fallbackPartial && fallbackError instanceof Error
          ? (fallbackError.cause ?? fallbackError)
          : fallbackError;
      finalizationError = finalizationError
        ? new AggregateError(
            [finalizationError, fallbackCause],
            "Feishu streaming finalization and static fallback failed",
          )
        : fallbackCause;
    }
    const mediaPartial = isChannelPartialDeliveryError(paramsLocal.error)
      ? paramsLocal.error.deliveryResult
      : undefined;
    const accepted = mergeFeishuReplyDeliveryResults(
      [
        finalized,
        ...(fallbackPartial ? [fallbackPartial] : []),
        ...(mediaPartial ? [mediaPartial] : []),
      ],
      discarded
        ? (finalized.content ?? "")
        : fallbackPartial?.visibleReplySent === true
          ? fallbackPartial.content
          : finalized.visibleReplySent === true
            ? finalized.content
            : paramsLocal.content,
    );
    const mediaCause =
      mediaPartial && paramsLocal.error instanceof Error
        ? (paramsLocal.error.cause ?? paramsLocal.error)
        : paramsLocal.error;
    const cause = finalizationError
      ? new AggregateError(
          [
            mediaCause,
            finalizationError instanceof Error
              ? (finalizationError.cause ?? finalizationError)
              : finalizationError,
          ],
          "Feishu reply delivery and streaming finalization failed",
        )
      : mediaCause;
    throw createFeishuPartialReplyDeliveryError(cause, accepted);
  };

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    responsePrefix,
    responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(cfg, agentId),
    silentReplyContext: {
      cfg,
      sessionKey: params.sessionKey,
      surface: "feishu",
      conversationType: chatId.startsWith("oc_") ? "group" : "direct",
    },
    onSkip: (_payload, info) => {
      if (
        replyOutcome?.kind !== "failed" &&
        (info.kind === "final" || (info.kind === "block" && info.reason === "silent"))
      ) {
        replyOutcome = {
          kind: "skipped",
          reason: info.reason,
          assistantMessageIndex: info.assistantMessageIndex,
        };
      }
    },
    beforeDeliver: (payload, info) => {
      // Enqueue-time silence may be newer than this queued block. Reset before either
      // modifying hook, since cancellation skips native delivery entirely.
      const preservesNewerSilence =
        replyOutcome?.kind === "skipped" &&
        replyOutcome.reason === "silent" &&
        info.kind !== "final" &&
        replyOutcome.assistantMessageIndex !== undefined &&
        info.assistantMessageIndex !== undefined &&
        info.assistantMessageIndex < replyOutcome.assistantMessageIndex;
      if (!preservesNewerSilence && replyOutcome?.kind !== "failed") {
        replyOutcome = undefined;
      }
      return payload;
    },
    onReplyStart: async () => {
      if (!replyLifecycleStateInitialized) {
        replyLifecycleStateInitialized = true;
        deliveredFinalTexts.clear();
        blockPostDeliveries.clear();
        closedStreamingSettlements.clear();
        sentIndependentBlockText = false;
        idleRequestedForReply = false;
        visibleReplySent = false;
        replyOutcome = undefined;
      }
      if (previewStreamingEnabled && renderMode === "card") {
        startStreaming();
      }
      await Promise.resolve(typingCallbacks?.onReplyStart?.());
    },
    onIdle: () => queueIdleSideEffects(),
    onCleanup: () => {
      typingCallbacks?.onCleanup?.();
    },
  };
  const handleDeliveryError = async (error: unknown, info: { kind: string }) => {
    if (info.kind === "final") {
      // Later suppression cannot erase a failed final; accepted visibility still
      // prevents recovery from duplicating any native reply.
      replyOutcome = { kind: "failed" };
    }
    if (isChannelPartialDeliveryError(error)) {
      // Core invokes this before no-visible recovery; keep accepted sends visible even
      // when their normal success bookkeeping could not run.
      markVisibleReplySent();
    }
    params.runtime.error?.(
      `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
    );
    await queueIdleSideEffects().catch((cleanupError: unknown) =>
      params.runtime.error?.(
        `feishu[${account.accountId}] reply error cleanup failed: ${String(cleanupError)}`,
      ),
    );
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    onDelivered: (_payload, info, result) => {
      if (result?.visibleReplySent) {
        markVisibleReplySent();
        if (info.kind === "final") {
          replyOutcome = undefined;
        }
        return;
      }
      const reason = result?.suppression?.reason;
      if (
        info.kind === "final" &&
        replyOutcome?.kind !== "failed" &&
        (reason === "cancelled_by_reply_payload_sending_hook" ||
          reason === "empty_after_reply_payload_sending_hook" ||
          reason === "cancelled_by_message_sending_hook" ||
          reason === "empty_after_message_sending_hook" ||
          reason === "channel_transform")
      ) {
        replyOutcome = { kind: "suppressed", reason };
      }
    },
    deliver: async (inputPayload: ReplyPayload, info) => {
      // Delivery runs after modifying hooks. Render here so native cards carry the
      // accepted prose, and a canceled payload never creates a card.
      const sourceText = inputPayload.text ?? "";
      const prepared = await renderFeishuReplyPayload(inputPayload, {
        to: sendTarget,
        identity,
        renderText: renderTables,
        tableMode,
        // Cards notify only required bot recipients; incoming user mentions remain context.
        mentions: requiredMentionTargets,
      });
      const rendered = consumeFeishuPresentationFallbackMarker(prepared.payload);
      const payload = rendered.payload;
      const presentationCard = prepared.card;
      const hasPresentationFallback = rendered.presentationFallback?.hasVisibleContent === true;
      // A presentation's prose reaches this payload converted, and the top-level text is only
      // part of it, so a cut that cannot carry the conversion falls back to the whole of what
      // the presentation contributed rather than to the fragment the payload came with.
      const authoredPayloadText = rendered.presentationFallback?.authoredText ?? sourceText;
      const hasIndependentPresentation = presentationCard !== undefined || hasPresentationFallback;
      const resolvedText = payload.text;
      const payloadText =
        payload.isReasoning && resolvedText
          ? formatReasoningPreservingStructure(resolvedText)
          : resolvedText;
      const reply = resolveSendableOutboundReplyParts({ ...payload, text: payloadText });
      // Reasoning retains its established formatted delivery. Answer snapshots
      // and mirrored blocks instead share unconverted prose.
      const streamSourceText = payload.isReasoning ? reply.text : sourceText;
      // reply.text already carries the conversion, so only the stream text this merge
      // reads still needs it, in the form the closing card, the closing record and the
      // delivered-final set hold.
      const text =
        info?.kind === "final" && !hasIndependentPresentation
          ? mergeStreamingFinalText(
              renderTables(streamText),
              reply.text,
              payload.isError === true && hasStreamingFinalText,
            )
          : reply.text;
      // The body a final settles with can be the streamed answer merged with this payload, and
      // the fallback has to be the same body unconverted, or a cut that cannot carry the
      // conversion posts the final alone and the answer it completed is lost.
      const authoredFallbackText =
        info?.kind === "final" && !hasIndependentPresentation
          ? mergeStreamingFinalText(
              streamText,
              authoredPayloadText,
              payload.isError === true && hasStreamingFinalText,
            )
          : authoredPayloadText;
      const hasText = reply.hasText;
      const hasMedia = reply.hasMedia;
      const ttsSupplement = getReplyPayloadTtsSupplement(payload);
      const ttsTextAlreadyVisible = ttsSupplement?.visibleTextAlreadyDelivered === true;
      const hasVoiceMedia =
        hasMedia &&
        reply.mediaUrls.some((mediaUrl) =>
          shouldSuppressFeishuTextForVoiceMedia({
            mediaUrl,
            ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
            ttsSupplement,
          }),
        );
      const finalTextExceedsStreamingLimit =
        info?.kind === "final" && hasText && text.length > textChunkLimit;
      // A block payload reaches a card of its own under block streaming, so the
      // exclusion covers every card-capable payload and not only a final.
      const tableNeedsPost =
        hasText && (tableNeedsPostPath(text) || answerTableNeedsPostPath(text));
      // Feishu's table ceiling applies to static card elements, not CardKit's streamed markdown.
      // Keep the intents separate so an active preview cannot fork into an independent post.
      const cardRenderingRequested =
        renderMode === "card" ||
        (info?.kind === "block" && coreBlockStreamingEnabled && renderMode !== "raw") ||
        (renderMode === "auto" && shouldUseCard(text, nativeTables));
      // A card carries a table as one component and the card chunker does not repeat the
      // header, so a table needing more than one card takes the post path instead. The
      // outbound send path asks the same question through the same rule.
      const cardKeepsTableWhole = cardCarriesWholeTable(text, (candidate) =>
        chunkFeishuCardMarkdown({ text: candidate, limit: textChunkLimit, mode: chunkMode }),
      );
      const useStaticCard =
        hasText &&
        cardRenderingRequested &&
        !tableNeedsPost &&
        withinCardTableLimit(text) &&
        cardKeepsTableWhole;
      const useStreamingCard =
        hasText &&
        streamingEnabled &&
        !finalTextExceedsStreamingLimit &&
        !tableNeedsPost &&
        (info?.kind === "final" || cardRenderingRequested);
      const skipTextForDuplicateFinal =
        !hasIndependentPresentation &&
        info?.kind === "final" &&
        hasText &&
        deliveredFinalTexts.has(text);
      const shouldDeliverText =
        hasText && (!hasVoiceMedia || hasPresentationFallback) && !skipTextForDuplicateFinal;
      // Error controls supplement a committed answer. Only a replacement final may
      // discard it; block/tool controls also leave the earlier reply owned by idle.
      const shouldDiscardStreamingPreview =
        info?.kind === "final" &&
        !(hasIndependentPresentation && payload.isError === true && hasStreamingFinalText) &&
        (hasIndependentPresentation ||
          finalTextExceedsStreamingLimit ||
          tableNeedsPost ||
          (hasMedia &&
            ((hasVoiceMedia && !shouldDeliverText && !ttsTextAlreadyVisible) ||
              skipTextForDuplicateFinal)));

      const priorClosedStreamingSettlement =
        info?.kind === "final" && hasText && skipTextForDuplicateFinal
          ? claimClosedStreamingResult(undefined, text)
          : undefined;
      if (!shouldDeliverText && !hasMedia && !presentationCard) {
        if (priorClosedStreamingSettlement?.error !== undefined) {
          throw toFeishuError(priorClosedStreamingSettlement.error);
        }
        return priorClosedStreamingSettlement?.result ?? noVisibleFeishuReplyDelivery;
      }

      const deliveredResults: FeishuReplyDeliveryResult[] = priorClosedStreamingSettlement
        ? [priorClosedStreamingSettlement.result]
        : [];
      // A partial text rejection owns its accepted chunks and must still reach the
      // caller, but an attachment is an independent send that the rejection should not
      // cancel. Sites that send text before media hold the failure here and surface it
      // once the media has been attempted, with both recorded.
      let textPartialFailure: unknown;
      const holdPartialForMedia = (error: unknown, hasMediaToSend: boolean): void => {
        const accepted = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
        if (!hasMediaToSend || !accepted) {
          throw error;
        }
        deliveredResults.push(accepted);
        textPartialFailure = error;
      };
      const collectDelivery = async (
        pending: Promise<FeishuReplyDeliveryResult>,
        acceptedContent?: string,
      ): Promise<void> => {
        try {
          deliveredResults.push(await pending);
        } catch (error: unknown) {
          const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
          const accumulated = mergeFeishuReplyDeliveryResults([
            ...deliveredResults,
            ...(partial ? [{ ...partial, content: partial.content ?? acceptedContent }] : []),
          ]);
          throw createFeishuPartialReplyDeliveryError(
            partial && error instanceof Error ? (error.cause ?? error) : error,
            // Media-only acceptance has no caption; omission would make core report
            // the rejected card's original prose as delivered.
            { ...accumulated, content: accumulated.content ?? "" },
          );
        }
      };

      if (shouldDiscardStreamingPreview) {
        await discardStreamingPreview();
      }

      if (presentationCard) {
        // A logical card owns its controls and attachments even when its prose repeats.
        if (hasMedia) {
          await collectDelivery(sendMediaReplies(payload));
        }
        await collectDelivery(
          sendCardFeishu({
            cfg,
            to: sendTarget,
            card: presentationCard,
            replyToMessageId: sendReplyToMessageId,
            replyInThread: effectiveReplyInThread,
            allowTopLevelReplyFallback,
            accountId,
          }).then((result) =>
            createFeishuReplyDeliveryResult({
              results: [result],
              visibleReplySent: true,
              content: resolvedText,
              kind: "card",
            }),
          ),
          resolvedText,
        );
        markVisibleReplySent();
        return mergeFeishuReplyDeliveryResults(deliveredResults, resolvedText);
      }

      if (shouldDeliverText) {
        // Later finals replace stream text. Each presentation fallback owns a
        // separate message; ordinary blocks retain their streaming policy.
        if (hasPresentationFallback || (info?.kind === "block" && !useStreamingCard)) {
          if (hasPresentationFallback || coreBlockStreamingEnabled) {
            const firstChunkMentions =
              info?.kind === "final" || (info?.kind === "block" && !sentIndependentBlockText)
                ? mentionTargets
                : undefined;
            // A partial text failure owns its accepted chunks, and a matching block that
            // already failed that way rethrows here rather than replaying them. The
            // attachment is an independent send, so the rejection holds until the media
            // has been attempted and both are reported together.
            try {
              await collectDelivery(
                sendPostReply(text, info?.kind, firstChunkMentions, {
                  authoredText: authoredFallbackText,
                }),
              );
            } catch (error: unknown) {
              holdPartialForMedia(error, hasMedia);
            }
            if (info?.kind === "block") {
              sentIndependentBlockText = true;
            }
            if (hasMedia) {
              await collectDelivery(sendMediaReplies(payload));
            }
            if (textPartialFailure !== undefined) {
              // No content override here. The merge derives it from what was accepted, and
              // handing it the whole reply would report the rejected suffix as delivered.
              const accumulated = mergeFeishuReplyDeliveryResults(deliveredResults);
              throw createFeishuPartialReplyDeliveryError(
                textPartialFailure instanceof Error
                  ? (textPartialFailure.cause ?? textPartialFailure)
                  : textPartialFailure,
                { ...accumulated, content: accumulated.content ?? "" },
              );
            }
          }
          // No content override here either. A fallback whose conversion the cut could not
          // carry sends the authored prose instead, and the merge already reports what the
          // senders accepted rather than what this branch asked them for.
          return mergeFeishuReplyDeliveryResults(deliveredResults);
        }
        if (info?.kind === "block" || (info?.kind === "final" && useStreamingCard)) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        const shouldStreamText = info?.kind === "block" || info?.kind === "final";
        const matchingInFlightClose =
          info?.kind === "final" &&
          inFlightStreamingClose?.disposition === "closed" &&
          inFlightStreamingClose.content === text
            ? inFlightStreamingClose
            : undefined;
        const ownerGeneration = activeStreamingGeneration ?? matchingInFlightClose?.generation;
        if (
          shouldStreamText &&
          ownerGeneration !== undefined &&
          (streaming?.isActive() || matchingInFlightClose !== undefined)
        ) {
          if (activeStreamingGeneration !== undefined) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              // A block repeating what the preview already streamed is compared on the
              // payload text both sides started from, so only new text is appended.
              queueStreamingUpdate(streamSourceText, {
                mode: "delta",
                dedupeWithLastPartial: true,
              });
            }
            if (info?.kind === "final") {
              // Final payloads can be cumulative snapshots or independent
              // notices. Preserve both when the latter arrives after an answer.
              streamText = mergeStreamingFinalText(
                streamText,
                streamSourceText,
                payload.isError === true && hasStreamingFinalText,
              );
              hasStreamingFinalText = true;
              snapshotBaseText = "";
              lastSnapshotTextLength = streamText.length;
              flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamDisplayText()));
            }
          }
          // Send media even when streaming handled the text
          if (hasMedia) {
            try {
              await collectDelivery(sendMediaReplies(payload));
            } catch (error: unknown) {
              await throwStreamingDeliveryFailure({
                error,
                content: text,
                infoKind: info?.kind,
                ownerGeneration,
              });
            }
          }
          return deferStreamingDelivery(
            mergeFeishuReplyDeliveryResults(deliveredResults, text),
            info?.kind,
            ownerGeneration,
          );
        }

        // Streaming eligibility can still fall back to a static card, so the provider ceiling
        // also applies when startup is unavailable or another generation is closing.
        const useFallbackCard =
          useStaticCard ||
          (useStreamingCard &&
            !isStreamingStartBackedOff(account.accountId) &&
            withinCardTableLimit(text) &&
            cardKeepsTableWhole);
        if (useFallbackCard) {
          deliveredResults.push(
            await sendChunkedTextReply({ text, useCard: true, infoKind: info?.kind }),
          );
        } else {
          const firstChunkMentions =
            info?.kind === "final" && mentionTargets?.length ? mentionTargets : undefined;
          try {
            deliveredResults.push(
              await sendPostReply(text, info?.kind, firstChunkMentions, {
                authoredText: authoredFallbackText,
              }),
            );
          } catch (error: unknown) {
            holdPartialForMedia(error, hasMedia);
          }
        }
      }

      if (hasMedia) {
        await collectDelivery(
          sendMediaReplies(
            payload,
            !shouldDeliverText && !ttsTextAlreadyVisible && hasVoiceMedia && hasText
              ? { fallbackText: text }
              : undefined,
          ),
        );
      }
      if (textPartialFailure !== undefined) {
        // Same here: the accepted chunks own the content, not the text that was requested.
        const withMedia = mergeFeishuReplyDeliveryResults(deliveredResults);
        throw createFeishuPartialReplyDeliveryError(
          textPartialFailure instanceof Error
            ? (textPartialFailure.cause ?? textPartialFailure)
            : textPartialFailure,
          { ...withMedia, content: withMedia.content ?? "" },
        );
      }
      // The delivered results own what was sent. The requested text stands in only when they
      // carry nothing of their own, as a media-only acceptance does.
      const deliveredContent = hasVoiceMedia
        ? (deliveredResults.at(-1)?.content ?? text)
        : (mergeFeishuReplyDeliveryResults(deliveredResults).content ?? text);
      const result = mergeFeishuReplyDeliveryResults(deliveredResults, deliveredContent);
      if (priorClosedStreamingSettlement?.error !== undefined) {
        throw createFeishuPartialReplyDeliveryError(
          isChannelPartialDeliveryError(priorClosedStreamingSettlement.error) &&
            priorClosedStreamingSettlement.error instanceof Error
            ? (priorClosedStreamingSettlement.error.cause ?? priorClosedStreamingSettlement.error)
            : priorClosedStreamingSettlement.error,
          result,
        );
      }
      return result;
    },
    // The shipped SDK declaration stays void; core still awaits the runtime promise.
    onError: handleDeliveryError as NonNullable<ChannelInboundTurnPlan["delivery"]["onError"]>,
  };

  return {
    dispatcherOptions,
    delivery,
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : true,
      onPartialReply: previewStreamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return false;
            }
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return false;
            }
            if (!answerTableNeedsPostPath(cleaned)) {
              startStreaming();
            }
            queueStreamingUpdate(cleaned, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
            return false;
          }
        : undefined,
      onReasoningStream: reasoningPreviewEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return false;
            }
            startStreaming();
            // Convert before the italic line wrapping, the same order the delivered
            // reasoning path uses, so the table is still parseable when the mode runs.
            queueReasoningUpdate(previewReasoningMessage(payload.text));
            return false;
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => false : undefined,
      onItemEvent: previewStreamingEnabled
        ? (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) => {
            if (
              payload.kind === "preamble" ||
              payload.hideFromChannelProgress ||
              payload.suppressChannelProgress
            ) {
              return false;
            }
            const { kind: itemKind, ...item } = payload;
            const statusLineLocal = formatChannelProgressDraftLineForEntry(account.config, {
              event: "item",
              itemKind,
              ...item,
            });
            if (statusLineLocal) {
              return updateStreamingStatusLine(statusLineLocal);
            }
            return false;
          }
        : undefined,
      onAssistantMessageStart: previewStreamingEnabled
        ? () => updateStreamingStatusLine("", { startIfNeeded: false })
        : undefined,
      onCompactionStart: previewStreamingEnabled
        ? () => updateStreamingStatusLine("📦 **Compacting context...**")
        : undefined,
      onCompactionEnd: previewStreamingEnabled ? () => updateStreamingStatusLine("") : undefined,
    },
    ensureNoVisibleReplyFallback,
    getVisibleReplyState: () => ({
      visibleReplySent,
      skippedFinalReason:
        replyOutcome?.kind === "skipped" || replyOutcome?.kind === "suppressed"
          ? replyOutcome.reason
          : null,
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
