import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "./reply-dispatcher-runtime-api.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu, type CardHeaderConfig } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";
import type { FeishuStatusLanguage } from "./types.js";

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

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig {
  const name = identity?.name?.trim() || agentId;
  const emoji = identity?.emoji?.trim();
  return {
    title: emoji ? `${emoji} ${name}` : name,
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

function sanitizeReplyText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/🧹\s*Compacting context\.\.\.\s*/g, "")
    .replace(/<\/?final>\s*/gi, "")
    .trim();
}

function isLikelyCodexScratchpadText(text: string, provider?: string): boolean {
  if ((provider ?? "").toLowerCase() !== "openai-codex") {
    return false;
  }
  const cleaned = sanitizeReplyText(text);
  if (!cleaned || /[\u4e00-\u9fff]/.test(cleaned)) {
    return false;
  }
  if (cleaned.length > 2000 || !/[A-Za-z]/.test(cleaned)) {
    return false;
  }
  if (/^\[\[reply_to_current\]\]/.test(cleaned)) {
    return false;
  }
  if (
    /^(Need|Need to|Let's|We can|Use |Only |Translation failed|Found |Now |Maybe |Better |Looks translated|Great|Good\b)/i.test(
      cleaned,
    )
  ) {
    return true;
  }
  if (
    /\b(?:tool|script|page|workflow|upload|translate|header|footer|meta|rest|curl|draft|create|update|inspect|verify|extract|body|html|template|slug|publish|wordpress|elementor)\b/i.test(
      cleaned,
    ) &&
    /\b(?:need|maybe|likely|could|should|let's|let us|try|test|inspect|verify|create|update|copy|fetch|extract|build|retry|respond)\b/i.test(
      cleaned,
    )
  ) {
    return true;
  }
  return (
    cleaned.split(/\s+/).length >= 8 &&
    /[.?!]/.test(cleaned) &&
    !/[`[{(<]/.test(cleaned) &&
    /^[A-Za-z0-9 ,.:;'"\/_-]+$/.test(cleaned) &&
    /\b(?:need|maybe|likely|could|should|let's|try|inspect|verify|create|update|copy|fetch|extract|build|retry|respond)\b/i.test(
      cleaned,
    )
  );
}

function resolveStatusCopy(language: FeishuStatusLanguage) {
  if (language === "en") {
    return {
      locale: "en-GB",
      statusLabel: "Status",
      activityLabel: "Last activity",
      processing: "In progress",
      finalizing: "Finalizing",
      completed: "Completed",
      completionPingPrefix: "Completed:",
    } as const;
  }
  return {
    locale: "zh-CN",
    statusLabel: "状态",
    activityLabel: "最后活动",
    processing: "处理中",
    finalizing: "整理结果",
    completed: "已完成",
    completionPingPrefix: "已完成：",
  } as const;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  allowReasoningPreview?: boolean;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  identity?: OutboundIdentity;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
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
    threadReply,
    rootId,
    mentionTargets,
    accountId,
    identity,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const { typingCallbacks } = createChannelReplyPipeline({
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
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";
  const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let streamingStartedAt = 0;
  let lastActivityAt = 0;
  const statusLanguage = account.config?.statusLanguage ?? "zh-CN";
  const statusCopy = resolveStatusCopy(statusLanguage);
  let lastKnownStatus = statusCopy.processing;
  const STREAMING_NOTE_HEARTBEAT_MS = 15_000;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const formatActivityTime = (timestamp: number): string =>
    timestamp > 0
      ? new Date(timestamp).toLocaleTimeString(statusCopy.locale, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "";

  const buildStreamingNote = (status = lastKnownStatus): string => {
    const base = resolveCardNote(agentId, identity, prefixContext.prefixContext);
    const parts = [base, `${statusCopy.statusLabel}: ${status}`];
    if (lastActivityAt > 0) {
      parts.push(`${statusCopy.activityLabel}: ${formatActivityTime(lastActivityAt)}`);
    }
    return parts.join(" | ");
  };

  const refreshStreamingNote = (status = lastKnownStatus) => {
    lastKnownStatus = status;
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.updateNoteContent(buildStreamingNote(status));
      }
    });
  };

  const markStreamingActivity = (status = statusCopy.processing) => {
    lastActivityAt = Date.now();
    refreshStreamingNote(status);
  };

  const stopHeartbeat = () => {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!streaming?.isActive()) {
        return;
      }
      lastActivityAt = Date.now();
      refreshStreamingNote(lastKnownStatus);
    }, STREAMING_NOTE_HEARTBEAT_MS);
  };

  const shouldSendCompletionPing = () =>
    streamingStartedAt > 0 && Date.now() - streamingStartedAt >= 15_000;

  const formatReasoningPrefix = (thinking: string): string => {
    if (!thinking) {
      return "";
    }
    const withoutLabel = thinking.replace(/^Reasoning:\n/, "");
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
    markStreamingActivity(statusCopy.processing);
    const mode = options?.mode ?? "snapshot";
    streamText =
      mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const queueReasoningUpdate = (nextThinking: string) => {
    if (!nextThinking) {
      return;
    }
    reasoningText = nextThinking;
    markStreamingActivity(statusCopy.processing);
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartedAt = Date.now();
    lastActivityAt = streamingStartedAt;
    lastKnownStatus = statusCopy.processing;
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
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: buildStreamingNote(statusCopy.processing),
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
        streamingStartPromise = null; // allow retry on next deliver
      }
    })();
    startHeartbeat();
  };

  const closeStreaming = async () => {
    stopHeartbeat();
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = buildCombinedStreamText(reasoningText, streamText);
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      lastKnownStatus = statusCopy.completed;
      lastActivityAt = Date.now();
      const finalNote = buildStreamingNote(statusCopy.completed);
      await streaming.close(text, { note: finalNote });
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    reasoningText = "";
    streamingStartedAt = 0;
    lastActivityAt = 0;
    lastKnownStatus = statusCopy.processing;
  };

  const sendChunkedTextReply = async (params: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    sendChunk: (params: { chunk: string; isFirst: boolean }) => Promise<void>;
  }) => {
    const chunkSource = params.useCard
      ? params.text
      : core.channel.text.convertMarkdownTables(params.text, tableMode);
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      core.channel.text.chunkTextWithMode(chunkSource, textChunkLimit, chunkMode),
    );
    for (const [index, chunk] of chunks.entries()) {
      await params.sendChunk({
        chunk,
        isFirst: index === 0,
      });
    }
    if (params.infoKind === "final") {
      deliveredFinalTexts.add(params.text);
    }
  };

  const sendMediaReplies = async (payload: ReplyPayload) => {
    await sendMediaWithLeadingCaption({
      mediaUrls: resolveSendableOutboundReplyParts(payload).mediaUrls,
      caption: "",
      send: async ({ mediaUrl }) => {
        await sendMediaFeishu({
          cfg,
          to: chatId,
          mediaUrl,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          accountId,
        });
      },
    });
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: async () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        await typingCallbacks?.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const reply = resolveSendableOutboundReplyParts(payload);
        const text = sanitizeReplyText(reply.text);
        const hasText =
          Boolean(text) && !isLikelyCodexScratchpadText(text, prefixContext.prefixContext.provider);
        const hasMedia = reply.hasMedia;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (shouldDeliverText) {
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
              queueStreamingUpdate(text, { mode: "delta" });
            }
            if (info?.kind === "final") {
              markStreamingActivity(statusCopy.finalizing);
              streamText = mergeStreamingText(streamText, text);
              await closeStreaming();
              deliveredFinalTexts.add(text);
              if (shouldSendCompletionPing()) {
                await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: `${statusCopy.completionPingPrefix} ${text.replace(/\n/g, " ").trim().slice(0, 100)}`,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              await sendMediaReplies(payload);
            }
            return;
          }

          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            await sendChunkedTextReply({
              text,
              useCard: true,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                await sendStructuredCardFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? mentionTargets : undefined,
                  accountId,
                  header: cardHeader,
                  note: cardNote,
                });
              },
            });
          } else {
            await sendChunkedTextReply({
              text,
              useCard: false,
              infoKind: info?.kind,
              sendChunk: async ({ chunk, isFirst }) => {
                await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  mentions: isFirst ? mentionTargets : undefined,
                  accountId,
                });
              },
            });
          }
        }

        if (hasMedia) {
          await sendMediaReplies(payload);
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks?.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks?.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks?.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: true,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            queueStreamingUpdate(payload.text, {
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
            queueReasoningUpdate(payload.text);
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => {} : undefined,
    },
    markDispatchIdle,
  };
}
