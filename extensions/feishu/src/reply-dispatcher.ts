// Feishu plugin module implements reply dispatcher behavior.
import { formatReasoningMessage, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  formatChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import { chunkFeishuPostMarkdown, materializeFeishuPostMarkdownSoftBreaks } from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  FeishuReplyDeliveryProgressError,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "./reply-dispatcher-runtime-api.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu, type CardHeaderConfig } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { createFeishuStreamingDeliveryCompletionQueue } from "./streaming-delivery-completion.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

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

function joinVisibleReplyContent(...parts: Array<string | undefined>): string | undefined {
  const visible = parts.filter((part): part is string => Boolean(part));
  return visible.length > 0 ? visible.join("\n") : undefined;
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

function rememberStreamingStartFailure(accountId: string, now = Date.now()): number {
  const backoffUntil = now + STREAMING_START_FAILURE_BACKOFF_MS;
  streamingStartBackoffUntilByAccount.set(accountId, backoffUntil);
  return backoffUntil;
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
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const { typingCallbacks } = createChannelMessageReplyPipeline({
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

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu", accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Streaming cards default to enabled: only streaming.mode "off" (or raw
  // render mode) disables them, matching the legacy `streaming: false` boolean.
  const streamingEnabled =
    !requiredMentionTargets?.length &&
    resolveChannelPreviewStreamMode(account.config, "partial") !== "off" &&
    renderMode !== "raw";
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
  const coreBlockStreamingEnabled = blockStreamingEnabled === true;
  const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;

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
  type PreparedTextDelivery = {
    text: string;
    finalTextExceedsStreamingLimit: boolean;
    useStreamingCard: boolean;
    finalTextWouldUseStreamingCard: boolean;
    useCard: boolean;
  };
  type TextDeliveryProgress = {
    chunks: string[];
    results: Map<number, FeishuReplyDeliverySource | undefined>;
  };
  const preparedTextDeliveryById = new Map<number, PreparedTextDelivery>();
  const textDeliveryProgressByKey = new Map<string, TextDeliveryProgress>();
  type MediaDeliveryProgressEntry = {
    mode: "send-media" | "fallback-text" | "degraded-fallback-text" | "complete";
    mediaResult?: FeishuReplyDeliverySource;
    fallbackResults: FeishuReplyDeliverySource[];
    fallbackText?: string;
    visibleContent?: string;
    visible: boolean;
  };
  const mediaDeliveryProgressByKey = new Map<string, Map<number, MediaDeliveryProgressEntry>>();
  const finalizedStreamingDeliveryByKey = new Map<string, FeishuReplyDeliveryResult>();
  const currentStreamingCompletedMediaProgressKeys = new Set<string>();
  let currentStreamingDeliveryKey: string | undefined;
  let sentIndependentBlockText = false;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let streamingClosedForReply = false;
  let streamingCloseErroredForReply = false;
  let visibleReplySent = false;
  let skippedFinalReason: string | null = null;
  let replyLifecycleStateInitialized = false;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const markVisibleReplySent = () => {
    visibleReplySent = true;
  };

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) {
      return "";
    }
    const withoutLabel = thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "");
    const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
    const lines = plain.split("\n").map((line) => `> ${line}`);
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
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(combined);
      }
    });
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
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) {
      return;
    }
    reasoningText = nextThinking;
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
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

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        const streamingTarget = sendTarget
          .replace(/^(feishu|lark):/i, "")
          .replace(/^(chat|user|group|dm|open_id):/i, "")
          .trim();
        await streaming.start(streamingTarget, resolveReceiveIdType(sendTarget), {
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
        streaming = null;
        streamingStartPromise = null;
      }
    })();
  };

  const resetStreamingState = () => {
    streaming = null;
    streamingStartPromise = null;
    partialUpdateQueue = Promise.resolve();
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    statusLine = "";
    snapshotBaseText = "";
    lastSnapshotTextLength = 0;
    hasStreamingFinalText = false;
    currentStreamingCompletedMediaProgressKeys.clear();
    currentStreamingDeliveryKey = undefined;
  };

  const closeStreaming = async (options?: {
    markClosedForReply?: boolean;
  }): Promise<FeishuReplyDeliveryResult> => {
    let acceptedRequestedFinal = false;
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        statusLine = "";
        const text = buildCombinedStreamText(reasoningText, streamText);
        const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        const result = await streaming.close(text, { note: finalNote });
        // Track the raw streamed text so the duplicate-final check in deliver()
        // can skip the redundant text delivery that arrives after turn settlement
        // closes the streaming card.
        if (result.visibleReplySent) {
          markVisibleReplySent();
        }
        // Only suppress a later fallback when CardKit accepted the requested final text.
        // Older visible content after a rejected rewrite must not masquerade as the final answer.
        if (result.visibleReplySent && result.content === text && streamText) {
          acceptedRequestedFinal = true;
          deliveredFinalTexts.add(streamText);
          if (
            currentStreamingDeliveryKey &&
            mediaDeliveryProgressByKey.has(currentStreamingDeliveryKey) &&
            !currentStreamingCompletedMediaProgressKeys.has(currentStreamingDeliveryKey)
          ) {
            // Keep the finalized card only while supplemental media is incomplete.
            // Completed media is cleared below; failed finalization has no valid card to cache.
            finalizedStreamingDeliveryByKey.set(currentStreamingDeliveryKey, result);
          }
          if (options?.markClosedForReply !== false && !streamingCloseErroredForReply) {
            streamingClosedForReply = true;
          }
        }
        if (!result.visibleReplySent && text) {
          throw new FeishuReplyDeliveryProgressError(
            new Error("Feishu streaming card accepted no requested final content"),
            { pendingParts: [{ kind: "text", index: 0 }] },
          );
        }
        if (result.visibleReplySent && result.content !== text) {
          throw createFeishuPartialReplyDeliveryError(
            new Error("Feishu streaming card retained stale content after finalization"),
            result,
            [{ kind: "text", index: 0 }],
          );
        }
        return result;
      }
      if (streamText) {
        throw new FeishuReplyDeliveryProgressError(
          new Error("Feishu streaming session became inactive before finalization"),
          { pendingParts: [{ kind: "text", index: 0 }] },
        );
      }
      return noVisibleFeishuReplyDelivery;
    } finally {
      if (acceptedRequestedFinal) {
        for (const progressKey of currentStreamingCompletedMediaProgressKeys) {
          mediaDeliveryProgressByKey.delete(progressKey);
        }
      }
      resetStreamingState();
    }
  };

  const discardStreamingPreview = async () => {
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        await streaming.discard();
      }
    } finally {
      resetStreamingState();
    }
  };

  const updateStreamingStatusLine = (
    nextStatusLine: string,
    options?: { startIfNeeded?: boolean },
  ) => {
    statusLine = nextStatusLine;
    const hasStreamingSession = Boolean(streaming?.isActive() || streamingStartPromise);
    if (!hasStreamingSession && (options?.startIfNeeded === false || renderMode !== "card")) {
      return;
    }
    startStreaming();
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const sendChunkedTextReply = async (paramsLocal: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    firstChunkMentions?: MentionTarget[];
    chunkMentions?: MentionTarget[];
    retainCompletedProgress?: boolean;
    progressIdentity: string;
    sendChunk: (params: {
      chunk: string;
      isFirst: boolean;
      mentions?: MentionTarget[];
    }) => Promise<FeishuReplyDeliverySource | void>;
  }): Promise<FeishuReplyDeliverySource[]> => {
    const existingProgress = textDeliveryProgressByKey.get(paramsLocal.progressIdentity);
    const progress =
      existingProgress ??
      (() => {
        const chunkSource = paramsLocal.useCard
          ? paramsLocal.text
          : materializeFeishuPostMarkdownSoftBreaks(
              core.channel.text.convertMarkdownTables(paramsLocal.text, tableMode),
            );
        const initialChunks = core.channel.text.chunkMarkdownTextWithMode(
          chunkSource,
          textChunkLimit,
          chunkMode,
        );
        const chunks = resolveTextChunksWithFallback(
          chunkSource,
          paramsLocal.useCard
            ? initialChunks
            : chunkFeishuPostMarkdown({
                text: chunkSource,
                limit: textChunkLimit,
                mode: chunkMode,
                firstChunkMentions: paramsLocal.firstChunkMentions,
                chunkMentions: paramsLocal.chunkMentions,
                initialChunks,
              }),
        );
        return {
          chunks,
          results: new Map<number, FeishuReplyDeliverySource | undefined>(),
        };
      })();
    // Retain the first rendered chunk plan with its logical delivery. Recomputing after a
    // streaming reset can change both visible text and card mode, duplicating accepted chunks.
    textDeliveryProgressByKey.set(paramsLocal.progressIdentity, progress);
    const { chunks, results } = progress;
    const listResults = () =>
      chunks.flatMap((_chunk, index) => {
        const result = results.get(index);
        return result ? [result] : [];
      });
    for (const [index, chunk] of chunks.entries()) {
      if (results.has(index)) {
        continue;
      }
      try {
        const mentions = [
          ...(paramsLocal.chunkMentions ?? []),
          ...(index === 0 ? (paramsLocal.firstChunkMentions ?? []) : []),
        ];
        const result = await paramsLocal.sendChunk({
          chunk,
          isFirst: index === 0,
          mentions: mentions.length > 0 ? mentions : undefined,
        });
        results.set(index, result ?? undefined);
        markVisibleReplySent();
      } catch (error: unknown) {
        const visibleChunks = chunks.filter((_chunk, chunkIndex) => results.has(chunkIndex));
        throw new FeishuReplyDeliveryProgressError(error, {
          results: listResults(),
          visibleContent: visibleChunks.length > 0 ? visibleChunks.join("\n") : undefined,
          pendingParts: chunks.flatMap((_pendingChunk, pendingIndex) =>
            results.has(pendingIndex) ? [] : [{ kind: "text" as const, index: pendingIndex }],
          ),
        });
      }
    }
    const completedResults = listResults();
    if (!paramsLocal.retainCompletedProgress) {
      textDeliveryProgressByKey.delete(paramsLocal.progressIdentity);
    }
    return completedResults;
  };

  const clearChunkedTextProgress = (progressIdentity: string) => {
    textDeliveryProgressByKey.delete(progressIdentity);
  };

  const sendMediaReplies = async (
    payload: ReplyPayload,
    options: { progressKey: string; fallbackText?: string },
  ): Promise<{
    results: FeishuReplyDeliverySource[];
    visibleReplySent: boolean;
    visibleContent?: string;
  }> => {
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    const progress =
      mediaDeliveryProgressByKey.get(options.progressKey) ??
      new Map<number, MediaDeliveryProgressEntry>();
    mediaDeliveryProgressByKey.set(options.progressKey, progress);
    const getEntry = (index: number): MediaDeliveryProgressEntry => {
      const existing = progress.get(index);
      if (existing) {
        return existing;
      }
      const created: MediaDeliveryProgressEntry = {
        mode: "send-media",
        fallbackResults: [],
        visible: false,
      };
      progress.set(index, created);
      return created;
    };
    const listResults = () =>
      mediaUrls.flatMap((_mediaUrl, index) => {
        const entry = progress.get(index);
        return entry
          ? [...(entry.mediaResult ? [entry.mediaResult] : []), ...entry.fallbackResults]
          : [];
      });
    const listVisibleContent = () =>
      joinVisibleReplyContent(
        ...mediaUrls.map((_mediaUrl, index) => progress.get(index)?.visibleContent),
      );
    let sentFallbackText = Array.from(progress.values()).some(
      (entry) => entry.fallbackText !== undefined,
    );
    const deliverFallback = async (entry: MediaDeliveryProgressEntry, mediaIndex: number) => {
      if (!entry.fallbackText) {
        entry.mode = "complete";
        return;
      }
      try {
        entry.fallbackResults = await sendChunkedTextReply({
          text: entry.fallbackText,
          useCard: false,
          infoKind: "final",
          chunkMentions: requiredMentionTargets,
          progressIdentity: JSON.stringify([options.progressKey, "fallback", mediaIndex]),
          sendChunk: async ({ chunk, mentions }) => {
            return await sendMessageFeishu({
              cfg,
              to: sendTarget,
              text: chunk,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              allowTopLevelReplyFallback,
              accountId,
              ...(mentions ? { mentions } : {}),
            });
          },
        });
        entry.visible = true;
        entry.visibleContent = entry.fallbackText;
        entry.mode = "complete";
      } catch (error: unknown) {
        const nested = error instanceof FeishuReplyDeliveryProgressError ? error : undefined;
        if (nested) {
          entry.fallbackResults = [...nested.results];
          entry.visible ||= Boolean(nested.visibleContent);
          entry.visibleContent = nested.visibleContent;
        }
        throw new FeishuReplyDeliveryProgressError(nested?.cause ?? error, {
          results: listResults(),
          visibleContent: listVisibleContent(),
          pendingParts: nested?.pendingParts,
        });
      }
    };

    for (const [index, mediaUrl] of mediaUrls.entries()) {
      const entry = getEntry(index);
      if (entry.mode === "complete") {
        continue;
      }
      if (entry.mode === "fallback-text" || entry.mode === "degraded-fallback-text") {
        await deliverFallback(entry, index);
        continue;
      }
      try {
        const result = await sendMediaFeishu({
          cfg,
          to: sendTarget,
          mediaUrl,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          allowTopLevelReplyFallback,
          accountId,
          ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        });
        entry.mediaResult = result;
        entry.visible = true;
        markVisibleReplySent();
        if (result?.voiceIntentDegradedToFile && options.fallbackText && !sentFallbackText) {
          sentFallbackText = true;
          entry.fallbackText = options.fallbackText;
          entry.mode = "degraded-fallback-text";
          await deliverFallback(entry, index);
        } else {
          entry.mode = "complete";
        }
      } catch (error: unknown) {
        if (error instanceof FeishuReplyDeliveryProgressError) {
          throw error;
        }
        if (options.fallbackText !== undefined) {
          entry.fallbackText = await buildFeishuMediaFallbackText({
            text: sentFallbackText ? undefined : options.fallbackText,
            mediaUrl,
          });
          sentFallbackText = true;
          entry.mode = "fallback-text";
          await deliverFallback(entry, index);
          continue;
        }
        progress.delete(index);
        throw new FeishuReplyDeliveryProgressError(error, {
          results: listResults(),
          pendingParts: mediaUrls.flatMap((_pendingMediaUrl, pendingIndex) => {
            const pending = progress.get(pendingIndex);
            return pending?.mode === "complete"
              ? []
              : [{ kind: "media" as const, index: pendingIndex }];
          }),
        });
      }
    }
    return {
      results: listResults(),
      visibleReplySent: Array.from(progress.values()).some((entry) => entry.visible),
      visibleContent: listVisibleContent(),
    };
  };

  const streamingDeliveryCompletions = createFeishuStreamingDeliveryCompletionQueue(
    core.channel.reply.attachDeliveryCompletion,
    closeStreaming,
    () => typingCallbacks?.onIdle?.(),
  );
  const queueIdleSideEffects = streamingDeliveryCompletions.queueIdle;

  const ensureNoVisibleReplyFallback = async (reason: string): Promise<boolean> => {
    await streamingDeliveryCompletions.waitForIdle();
    if (visibleReplySent) {
      return false;
    }
    if (skippedFinalReason === "silent") {
      params.runtime.log?.(
        `feishu[${account.accountId}]: no-visible-reply fallback skipped for intentional silence (${reason})`,
      );
      return false;
    }
    await sendMessageFeishu({
      cfg,
      to: sendTarget,
      text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
      replyToMessageId: sendReplyToMessageId,
      replyInThread: effectiveReplyInThread,
      allowTopLevelReplyFallback,
      accountId,
      ...(requiredMentionTargets?.length ? { mentions: requiredMentionTargets } : {}),
    });
    markVisibleReplySent();
    params.runtime.error?.(
      `feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`,
    );
    return true;
  };

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: resolveHumanDelayConfig(cfg, agentId),
    silentReplyContext: {
      cfg,
      sessionKey: params.sessionKey,
      surface: "feishu",
      conversationType: chatId.startsWith("oc_") ? "group" : "direct",
    },
    onSkip: (_payload, info) => {
      if (info.kind === "final") {
        skippedFinalReason = info.reason;
      }
    },
    onReplyStart: async () => {
      if (!replyLifecycleStateInitialized) {
        replyLifecycleStateInitialized = true;
        deliveredFinalTexts.clear();
        sentIndependentBlockText = false;
        streamingClosedForReply = false;
        streamingCloseErroredForReply = false;
        visibleReplySent = false;
        textDeliveryProgressByKey.clear();
        mediaDeliveryProgressByKey.clear();
        finalizedStreamingDeliveryByKey.clear();
        preparedTextDeliveryById.clear();
        currentStreamingCompletedMediaProgressKeys.clear();
        skippedFinalReason = null;
      }
      await Promise.resolve(typingCallbacks?.onReplyStart?.());
    },
    // CardKit owns the final visible content and provider id. The channel-turn kernel awaits
    // onSettled before releasing the turn; dispatcher onIdle is intentionally fire-and-forget.
    onSettled: () => queueIdleSideEffects(),
    onCleanup: () => {
      textDeliveryProgressByKey.clear();
      preparedTextDeliveryById.clear();
      mediaDeliveryProgressByKey.clear();
      finalizedStreamingDeliveryByKey.clear();
      deliveredFinalTexts.clear();
      currentStreamingCompletedMediaProgressKeys.clear();
      typingCallbacks?.onCleanup?.();
    },
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    deliver: async (payload: ReplyPayload, info) => {
      const deliveryResults: FeishuReplyDeliverySource[] = [];
      let payloadVisibleReplySent = false;
      let payloadVisibleContent: string | undefined;
      let deliveryText: string | undefined;
      let deliveryRetryKey: string | undefined;
      const clearMediaProgress = () => {
        if (deliveryRetryKey) {
          mediaDeliveryProgressByKey.delete(deliveryRetryKey);
        }
      };
      try {
        const deliveryId = info.deliveryId;
        if (deliveryId === undefined) {
          throw new Error("Feishu reply delivery requires dispatcher delivery identity");
        }
        if (info?.kind === "final") {
          skippedFinalReason = null;
        }
        const payloadText =
          payload.isReasoning && payload.text ? formatReasoningMessage(payload.text) : payload.text;
        const reply = resolveSendableOutboundReplyParts({ ...payload, text: payloadText });
        const proposedText =
          info?.kind === "final"
            ? mergeStreamingFinalText(
                streamText,
                reply.text,
                payload.isError === true && hasStreamingFinalText,
              )
            : reply.text;
        deliveryRetryKey = String(deliveryId);
        const hasText = reply.hasText;
        const hasMedia = reply.hasMedia;
        const ttsSupplement = getReplyPayloadTtsSupplement(payload);
        const ttsTextAlreadyVisible = ttsSupplement?.visibleTextAlreadyDelivered === true;
        const proposedFinalTextExceedsStreamingLimit =
          info.kind === "final" && hasText && proposedText.length > textChunkLimit;
        const proposedUseStaticCard =
          hasText &&
          (renderMode === "card" ||
            (info.kind === "block" && coreBlockStreamingEnabled && renderMode !== "raw") ||
            (renderMode === "auto" && shouldUseCard(proposedText)));
        const proposedUseStreamingCard =
          hasText &&
          streamingEnabled &&
          !proposedFinalTextExceedsStreamingLimit &&
          (info.kind === "final" || proposedUseStaticCard);
        const preparedTextDelivery = hasText
          ? (preparedTextDeliveryById.get(deliveryId) ?? {
              text: proposedText,
              finalTextExceedsStreamingLimit: proposedFinalTextExceedsStreamingLimit,
              useStreamingCard: proposedUseStreamingCard,
              finalTextWouldUseStreamingCard: info.kind === "final" && streamingEnabled,
              useCard: proposedUseStaticCard || proposedUseStreamingCard,
            })
          : undefined;
        if (preparedTextDelivery && !preparedTextDeliveryById.has(deliveryId)) {
          // Streaming preview state is transient, but provider retry state is not. Preserve the
          // first final rendering so recovery cannot resend a different text/card plan.
          preparedTextDeliveryById.set(deliveryId, preparedTextDelivery);
        }
        const text = preparedTextDelivery?.text ?? proposedText;
        deliveryText = text;
        const finalizedStreamingDelivery = finalizedStreamingDeliveryByKey.get(deliveryRetryKey);
        if (finalizedStreamingDelivery) {
          deliveryResults.push(finalizedStreamingDelivery);
          payloadVisibleReplySent = true;
          payloadVisibleContent = finalizedStreamingDelivery.content;
        }
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
          preparedTextDelivery?.finalTextExceedsStreamingLimit ?? false;
        const useStreamingCard = preparedTextDelivery?.useStreamingCard ?? false;
        const finalTextWouldUseStreamingCard =
          preparedTextDelivery?.finalTextWouldUseStreamingCard ?? false;
        const useCard = preparedTextDelivery?.useCard ?? false;
        const hasRetainedTextProgress = textDeliveryProgressByKey.has(deliveryRetryKey);
        const skipTextForDuplicateFinal =
          info?.kind === "final" &&
          hasText &&
          deliveredFinalTexts.has(text) &&
          !hasRetainedTextProgress;
        const skipTextForClosedStreamingFinal =
          info?.kind === "final" &&
          hasText &&
          streamingClosedForReply &&
          !streamingCloseErroredForReply &&
          finalTextWouldUseStreamingCard;
        const skipTextForFinalizedStreamingRecovery = Boolean(finalizedStreamingDelivery);
        const shouldDeliverText =
          hasText &&
          !hasVoiceMedia &&
          !skipTextForDuplicateFinal &&
          !skipTextForClosedStreamingFinal &&
          !skipTextForFinalizedStreamingRecovery;
        const shouldDiscardStreamingPreview =
          info?.kind === "final" &&
          (finalTextExceedsStreamingLimit ||
            (hasMedia &&
              ((hasVoiceMedia && !shouldDeliverText && !ttsTextAlreadyVisible) ||
                skipTextForDuplicateFinal ||
                skipTextForFinalizedStreamingRecovery)));
        if (!shouldDeliverText && !hasMedia) {
          return noVisibleFeishuReplyDelivery;
        }

        if (shouldDiscardStreamingPreview) {
          await discardStreamingPreview();
        }

        if (shouldDeliverText) {
          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content or send them as independent
            // messages for true progressive delivery.
            if (!useStreamingCard) {
              let visibleBlockReplySent = false;
              if (coreBlockStreamingEnabled) {
                // Reuse normal text chunking, but notify mentions only on the first visible chunk.
                const isFirstBlock = !sentIndependentBlockText;
                const firstChunkMentions =
                  isFirstBlock && mentionTargets?.length ? mentionTargets : undefined;
                deliveryResults.push(
                  ...(await sendChunkedTextReply({
                    text,
                    useCard: false,
                    infoKind: "block",
                    retainCompletedProgress: hasMedia,
                    progressIdentity: deliveryRetryKey,
                    firstChunkMentions,
                    chunkMentions: requiredMentionTargets,
                    sendChunk: async ({ chunk, mentions }) => {
                      return await sendMessageFeishu({
                        cfg,
                        to: sendTarget,
                        text: chunk,
                        replyToMessageId: sendReplyToMessageId,
                        replyInThread: effectiveReplyInThread,
                        allowTopLevelReplyFallback,
                        accountId,
                        ...(mentions ? { mentions } : {}),
                      });
                    },
                  })),
                );
                visibleBlockReplySent = true;
                payloadVisibleReplySent = true;
                payloadVisibleContent = text;
                sentIndependentBlockText = true;
                if (hasMedia) {
                  const mediaDelivery = await sendMediaReplies(payload, {
                    progressKey: deliveryRetryKey,
                  });
                  deliveryResults.push(...mediaDelivery.results);
                  clearMediaProgress();
                  clearChunkedTextProgress(deliveryRetryKey);
                }
              }
              // Text-bearing internal blocks suppress their attached media too when block delivery
              // is disabled. Media-only blocks bypass this branch and are delivered below.
              return createFeishuReplyDeliveryResult({
                results: deliveryResults,
                visibleReplySent: visibleBlockReplySent,
                content: visibleBlockReplySent ? text : undefined,
              });
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && useStreamingCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          const shouldStreamText = info?.kind === "block" || info?.kind === "final";
          if (streaming?.isActive() && shouldStreamText) {
            currentStreamingDeliveryKey = deliveryRetryKey;
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text, { mode: "delta", dedupeWithLastPartial: true });
            }
            if (info?.kind === "final") {
              // Final payloads can be cumulative snapshots or independent
              // notices. Preserve both when the latter arrives after an answer.
              streamText = text;
              hasStreamingFinalText = true;
              snapshotBaseText = "";
              lastSnapshotTextLength = text.length;
              flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              const mediaDelivery = await sendMediaReplies(payload, {
                progressKey: deliveryRetryKey,
              });
              deliveryResults.push(...mediaDelivery.results);
              currentStreamingCompletedMediaProgressKeys.add(deliveryRetryKey);
              payloadVisibleReplySent = mediaDelivery.visibleReplySent;
            }
            return streamingDeliveryCompletions.defer(
              createFeishuReplyDeliveryResult({
                results: deliveryResults,
                visibleReplySent: payloadVisibleReplySent,
              }),
            );
          }

          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            deliveryResults.push(
              ...(await sendChunkedTextReply({
                text,
                useCard: true,
                infoKind: info?.kind,
                retainCompletedProgress: hasMedia,
                progressIdentity: deliveryRetryKey,
                chunkMentions: requiredMentionTargets,
                sendChunk: async ({ chunk, mentions }) => {
                  return await sendStructuredCardFeishu({
                    cfg,
                    to: sendTarget,
                    text: chunk,
                    replyToMessageId: sendReplyToMessageId,
                    replyInThread: effectiveReplyInThread,
                    allowTopLevelReplyFallback,
                    accountId,
                    header: cardHeader,
                    note: cardNote,
                    ...(mentions ? { mentions } : {}),
                  });
                },
              })),
            );
            payloadVisibleReplySent = true;
            payloadVisibleContent = text;
          } else {
            const firstChunkMentions =
              info?.kind === "final" && mentionTargets?.length ? mentionTargets : undefined;
            deliveryResults.push(
              ...(await sendChunkedTextReply({
                text,
                useCard: false,
                infoKind: info?.kind,
                retainCompletedProgress: hasMedia,
                firstChunkMentions,
                chunkMentions: requiredMentionTargets,
                progressIdentity: deliveryRetryKey,
                sendChunk: async ({ chunk, mentions }) => {
                  return await sendMessageFeishu({
                    cfg,
                    to: sendTarget,
                    text: chunk,
                    replyToMessageId: sendReplyToMessageId,
                    replyInThread: effectiveReplyInThread,
                    allowTopLevelReplyFallback,
                    accountId,
                    ...(mentions ? { mentions } : {}),
                  });
                },
              })),
            );
            payloadVisibleReplySent = true;
            payloadVisibleContent = text;
          }
        }

        if (hasMedia) {
          const mediaDelivery = await sendMediaReplies(payload, {
            progressKey: deliveryRetryKey,
            ...(hasVoiceMedia && hasText ? { fallbackText: text } : {}),
          });
          deliveryResults.push(...mediaDelivery.results);
          clearMediaProgress();
          finalizedStreamingDeliveryByKey.delete(deliveryRetryKey);
          if (shouldDeliverText) {
            clearChunkedTextProgress(deliveryRetryKey);
          }
          payloadVisibleReplySent ||= mediaDelivery.visibleReplySent;
          payloadVisibleContent = joinVisibleReplyContent(
            payloadVisibleContent,
            mediaDelivery.visibleContent,
          );
        }
        if (info?.kind === "final" && shouldDeliverText) {
          // Duplicate suppression is valid only after the complete logical payload succeeds.
          // A text send followed by media failure remains retry progress, not a completed final.
          deliveredFinalTexts.add(text);
        }
        return createFeishuReplyDeliveryResult({
          results: deliveryResults,
          visibleReplySent: payloadVisibleReplySent,
          content: payloadVisibleContent,
        });
      } catch (error: unknown) {
        const progress = error instanceof FeishuReplyDeliveryProgressError ? error : undefined;
        if (progress) {
          deliveryResults.push(...progress.results);
        }
        const pendingParts = [...(progress?.pendingParts ?? [])];
        const pendingPartKeys = new Set(pendingParts.map((part) => `${part.kind}:${part.index}`));
        const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
        const mediaProgress = deliveryRetryKey
          ? mediaDeliveryProgressByKey.get(deliveryRetryKey)
          : undefined;
        for (const [index, _mediaUrl] of mediaUrls.entries()) {
          const entry = mediaProgress?.get(index);
          const mediaStillPending = !entry || entry.mode === "send-media";
          const partKey = `media:${index}`;
          if (mediaStillPending && !pendingPartKeys.has(partKey)) {
            pendingParts.push({ kind: "media", index });
            pendingPartKeys.add(partKey);
          }
        }
        // Some Feishu send helpers can confirm visibility without returning a receipt.
        // Preserve that fact so a later failure remains a partial delivery.
        const partialVisibleReplySent =
          payloadVisibleReplySent ||
          progress?.visibleContent !== undefined ||
          Array.from(mediaProgress?.values() ?? []).some((entry) => entry.visible) ||
          deliveryResults.length > 0;
        const partialResult = createFeishuReplyDeliveryResult({
          results: deliveryResults,
          visibleReplySent: partialVisibleReplySent,
          content: joinVisibleReplyContent(
            payloadVisibleContent,
            progress?.visibleContent,
            payloadVisibleReplySent && !payloadVisibleContent ? deliveryText : undefined,
          ),
        });
        const failureCause = progress?.cause ?? error;
        if (streaming?.isActive()) {
          throw streamingDeliveryCompletions.deferFailure(error, partialResult, pendingParts);
        }
        throw createFeishuPartialReplyDeliveryError(failureCause, partialResult, pendingParts);
      }
    },
    // The shipped SDK declaration stays void; core still awaits the runtime promise.
    onError: (async (error, info) => {
      streamingCloseErroredForReply = true;
      streamingClosedForReply = false;
      params.runtime.error?.(
        `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
      );
      await queueIdleSideEffects({ markClosedForReply: false });
    }) as NonNullable<ChannelInboundTurnPlan["delivery"]["onError"]>,
  };

  return {
    dispatcherOptions,
    delivery,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : true,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return;
            }
            startStreaming();
            queueStreamingUpdate(cleaned, {
              dedupeWithLastPartial: true,
              mode: "snapshot",
            });
          }
        : undefined,
      onReasoningStream: reasoningPreviewEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            startStreaming();
            queueReasoningUpdate(formatReasoningMessage(payload.text));
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => {} : undefined,
      onToolStart: streamingEnabled
        ? (payload: {
            name?: string;
            phase?: string;
            args?: Record<string, unknown>;
            detailMode?: "explain" | "raw";
          }) => {
            if (!isChannelProgressDraftWorkToolName(payload.name)) {
              return;
            }
            const statusLineLocal = formatChannelProgressDraftLineForEntry(
              account.config,
              {
                event: "tool",
                name: payload.name,
                phase: payload.phase,
                args: payload.args,
              },
              {
                detailMode: payload.detailMode,
              },
            );
            if (statusLineLocal) {
              updateStreamingStatusLine(statusLineLocal);
            }
          }
        : undefined,
      onAssistantMessageStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("", { startIfNeeded: false });
          }
        : undefined,
      onCompactionStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("📦 **Compacting context...**");
          }
        : undefined,
      onCompactionEnd: streamingEnabled
        ? () => {
            updateStreamingStatusLine("");
          }
        : undefined,
    },
    ensureNoVisibleReplyFallback,
    getVisibleReplyState: () => ({
      visibleReplySent,
      skippedFinalReason,
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
