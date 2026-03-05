import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent, normalizeMentionTagsForCard } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** Whether card streaming status is allowed in thread/topic replies (default: false). */
  streamingInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Bot open_id used to identify this app's typing reaction during cleanup lookup. */
  botOpenId?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
  /** Callback fired when a final visible text reply has been delivered. */
  onFinalTextDelivered?: (params: {
    text: string;
    messageId?: string;
    chatId: string;
    accountId?: string;
  }) => Promise<void> | void;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    streamingInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
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
        messageId: replyToMessageId,
        accountId,
        botOpenId: params.botOpenId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
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
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled =
    account.config?.streaming !== false &&
    renderMode !== "raw" &&
    (!threadReplyMode || streamingInThread === true);

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let lastRenderedStreamContent = "";
  let streamPhase: "idle" | "thinking" | "tool" | "streaming" = "idle";
  let toolUseCount = 0;
  let lastToolName: string | undefined;
  let hasThinkingPrelude = false;
  let stagedStatusLine: string | undefined;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let finalTextEmitted = false;

  const emitFinalTextIfNeeded = async (text: string, messageId?: string) => {
    const normalized = text.trim();
    if (!normalized || finalTextEmitted || typeof params.onFinalTextDelivered !== "function") {
      return;
    }
    finalTextEmitted = true;
    try {
      await params.onFinalTextDelivered({
        text: normalized,
        messageId,
        chatId,
        accountId: accountId ?? account.accountId,
      });
    } catch (error) {
      params.runtime.error?.(
        `feishu[${account.accountId}] onFinalTextDelivered failed: ${String(error)}`,
      );
    }
  };

  const normalizeToolName = (name: string | undefined): string | undefined => {
    const trimmed = name?.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.replace(/\s+/g, " ");
  };

  const resolveStatusLine = (): string | undefined => {
    if (streamPhase === "thinking") {
      return "💭 思考中...";
    }
    if (streamPhase === "tool") {
      if (toolUseCount >= 2) {
        return `🔧 已使用 ${toolUseCount} 个工具，正在处理...`;
      }
      const toolName = lastToolName?.trim();
      return toolName ? `🔧 正在使用${toolName}工具...` : "🔧 正在使用工具...";
    }
    return undefined;
  };

  const composeStreamingContent = (mode: "live" | "final" = "live"): string => {
    const assistantText = streamText;
    if (mode === "final") {
      return assistantText;
    }
    const statusLine = resolveStatusLine();
    if (!statusLine) {
      return assistantText;
    }
    if (!assistantText) {
      return statusLine;
    }
    return `${statusLine}\n---\n${assistantText}`;
  };

  const mergeStreamingText = (nextText: string) => {
    if (!streamText) {
      streamText = nextText;
      return;
    }
    if (nextText.startsWith(streamText)) {
      // Handle cumulative partial payloads where nextText already includes prior text.
      streamText = nextText;
      return;
    }
    if (streamText.endsWith(nextText)) {
      return;
    }
    streamText += nextText;
  };

  const queueStreamingRender = (renderedSnapshot?: string) => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (!streaming?.isActive()) {
        return;
      }
      const rendered = renderedSnapshot ?? composeStreamingContent("live");
      const renderedForCard = normalizeMentionTagsForCard(rendered);
      if (!renderedForCard || renderedForCard === lastRenderedStreamContent) {
        return;
      }
      lastRenderedStreamContent = renderedForCard;
      await streaming.update(renderedForCard, { mode: "replace" });
    });
  };

  const shouldRenderStreamingStatus = (): boolean =>
    renderMode === "card" || Boolean(streamingStartPromise) || Boolean(streaming?.isActive());

  const queueThinkingPrelude = (): boolean => {
    if (hasThinkingPrelude) {
      return false;
    }
    streamPhase = "thinking";
    stagedStatusLine = resolveStatusLine();
    hasThinkingPrelude = true;
    return true;
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
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
    const hadVisibleText = Boolean(streamText);
    mergeStreamingText(nextText);
    const shouldRenderStagedStatus =
      !hadVisibleText && Boolean(streamText) && Boolean(stagedStatusLine);
    const stagedSnapshot = shouldRenderStagedStatus
      ? `${stagedStatusLine}\n---\n${streamText}`
      : undefined;
    if (shouldRenderStagedStatus) {
      stagedStatusLine = undefined;
    }
    streamPhase = "streaming";
    if (stagedSnapshot) {
      queueStreamingRender(stagedSnapshot);
      // Immediately follow with plain text so close(finalText) remains text-only.
      queueStreamingRender();
      return;
    }
    queueStreamingRender();
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async (options?: { emitFinalText?: boolean }) => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    const streamMessageId = streaming?.getMessageId();
    if (streaming?.isActive()) {
      const finalText = composeStreamingContent("final");
      if (!finalText.trim()) {
        await streaming.discard();
      } else {
        let text = finalText;
        if (mentionTargets?.length) {
          text = buildMentionedCardContent(mentionTargets, text);
        }
        await streaming.close(normalizeMentionTagsForCard(text));
      }
      if (options?.emitFinalText !== false) {
        await emitFinalTextIfNeeded(finalText, streamMessageId);
      }
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    lastRenderedStreamContent = "";
    streamPhase = "idle";
    toolUseCount = 0;
    lastToolName = undefined;
    hasThinkingPrelude = false;
    stagedStatusLine = undefined;
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;

        if (!hasText && !hasMedia) {
          return;
        }

        if (hasText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueThinkingPrelude();
              queueStreamingUpdate(text);
            }
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming({ emitFinalText: true });
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
            }
            return;
          }

          let first = true;
          let firstMessageId: string | undefined;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              const sent = await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              const sentMessageId = sent?.messageId;
              if (!firstMessageId && typeof sentMessageId === "string" && sentMessageId.trim()) {
                firstMessageId = sentMessageId;
              }
              first = false;
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              const sent = await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              const sentMessageId = sent?.messageId;
              if (!firstMessageId && typeof sentMessageId === "string" && sentMessageId.trim()) {
                firstMessageId = sentMessageId;
              }
              first = false;
            }
          }
          if (info?.kind === "final") {
            await emitFinalTextIfNeeded(text, firstMessageId);
          }
        }

        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
            });
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming({ emitFinalText: false });
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming({ emitFinalText: true });
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onAssistantMessageStart: streamingEnabled
        ? () => {
            if (renderMode !== "card") {
              return;
            }
            queueThinkingPrelude();
          }
        : undefined,
      onReasoningStream: streamingEnabled
        ? () => {
            queueThinkingPrelude();
            streamPhase = "thinking";
            stagedStatusLine = resolveStatusLine();
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            if (!streaming?.isActive()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onReasoningEnd: streamingEnabled
        ? () => {
            if (streamPhase !== "thinking") {
              return;
            }
            streamPhase = streamText ? "streaming" : "idle";
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onToolStart: streamingEnabled
        ? (payload) => {
            const isStartPhase = !payload?.phase || payload.phase === "start";
            if (isStartPhase) {
              toolUseCount += 1;
              lastToolName = normalizeToolName(payload?.name) ?? lastToolName;
            }
            queueThinkingPrelude();
            streamPhase = "tool";
            stagedStatusLine = resolveStatusLine();
            if (!shouldRenderStreamingStatus()) {
              return;
            }
            if (!streaming?.isActive()) {
              return;
            }
            queueStreamingRender();
          }
        : undefined,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            // Ensure streaming card is started when partial text arrives.
            // In embedded mode with block streaming, the card is started by the
            // deliver handler on the first block reply. CLI mode has no block
            // streaming — text arrives as complete chunks via onPartialReply —
            // so the card must be started here. startStreaming() is idempotent
            // (guarded by streamingStartPromise), so calling it here is safe
            // even when the card was already started by deliver.
            queueThinkingPrelude();
            startStreaming();
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
