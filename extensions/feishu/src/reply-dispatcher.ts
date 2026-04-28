import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-runtime";
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

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
const STREAMING_START_FAILURE_BACKOFF_MS = 60_000;
const streamingStartBackoffUntilByAccount = new Map<string, number>();

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

export function clearFeishuStreamingStartBackoffForTests() {
  streamingStartBackoffUntilByAccount.clear();
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
  const emoji = identity?.emoji?.trim();
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
  /** Session key for internal message:sent hooks on normal Feishu replies. */
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
};

function formatHookError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function emitFeishuMessageSentHooks(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  hasMessageSentHooks: boolean;
  runtime: RuntimeEnv;
  chatId: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: string;
}): void {
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  if (!params.hasMessageSentHooks && !canEmitInternalHook) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.chatId,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "feishu",
    accountId: params.accountId,
    conversationId: params.chatId,
    messageId: params.messageId,
    isGroup: params.mirrorIsGroup,
    groupId: params.mirrorGroupId,
  });
  const logHookFailure = (message: string) => {
    params.runtime.log?.(message);
  };
  if (params.hasMessageSentHooks) {
    fireAndForgetHook(
      params.hookRunner!.runMessageSent(
        toPluginMessageSentEvent(canonical),
        toPluginMessageContext(canonical),
      ),
      "feishu: message_sent plugin hook failed",
      logHookFailure,
    );
  }
  if (!canEmitInternalHook) {
    return;
  }
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks!,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "feishu: message:sent internal hook failed",
    logHookFailure,
  );
}

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
    sessionKeyForInternalHooks,
    mirrorIsGroup,
    mirrorGroupId,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });
  const hookRunner = getGlobalHookRunner();
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const emitMessageSent = (event: {
    content: string;
    success: boolean;
    error?: string;
    messageId?: string;
  }) =>
    emitFeishuMessageSentHooks({
      hookRunner,
      hasMessageSentHooks,
      runtime: params.runtime,
      chatId,
      accountId,
      sessionKeyForInternalHooks,
      mirrorIsGroup,
      mirrorGroupId,
      ...event,
    });

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
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";
  const reasoningPreviewEnabled = streamingEnabled && params.allowReasoningPreview === true;

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  let statusLine = "";
  let snapshotBaseText = "";
  let lastSnapshotTextLength = 0;
  let streamingSentHookEmitted = false;
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  type StreamTextUpdateMode = "snapshot" | "delta";

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

  const closeStreaming = async (options?: { emitMessageSent?: boolean }) => {
    try {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await partialUpdateQueue;
      if (streaming?.isActive()) {
        statusLine = "";
        let text = buildCombinedStreamText(reasoningText, streamText);
        if (mentionTargets?.length) {
          text = buildMentionedCardContent(mentionTargets, text);
        }
        const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        const messageId = streaming.getMessageId();
        await streaming.close(text, { note: finalNote });
        // Track the raw streamed text so the duplicate-final check in deliver()
        // can skip the redundant text delivery that arrives after onIdle closes
        // the streaming card.
        if (streamText) {
          deliveredFinalTexts.add(streamText);
        }
        if (options?.emitMessageSent && streamText && !streamingSentHookEmitted) {
          streamingSentHookEmitted = true;
          emitMessageSent({
            content: streamText,
            success: true,
            messageId,
          });
        }
      }
    } finally {
      streaming = null;
      streamingStartPromise = null;
      partialUpdateQueue = Promise.resolve();
      streamText = "";
      lastPartial = "";
      reasoningText = "";
      statusLine = "";
      snapshotBaseText = "";
      lastSnapshotTextLength = 0;
      streamingSentHookEmitted = false;
    }
  };

  const updateStreamingStatusLine = (nextStatusLine: string) => {
    statusLine = nextStatusLine;
    if (!streaming?.isActive() && !streamingStartPromise && renderMode !== "card") {
      return;
    }
    startStreaming();
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };

  const sendChunkedTextReply = async (params: {
    text: string;
    useCard: boolean;
    infoKind?: string;
    sendChunk: (params: { chunk: string; isFirst: boolean }) => Promise<{ messageId?: string }>;
  }): Promise<{ messageId?: string } | undefined> => {
    const chunkSource = params.useCard
      ? params.text
      : core.channel.text.convertMarkdownTables(params.text, tableMode);
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      core.channel.text.chunkTextWithMode(chunkSource, textChunkLimit, chunkMode),
    );
    let lastResult: { messageId?: string } | undefined;
    for (const [index, chunk] of chunks.entries()) {
      lastResult = await params.sendChunk({
        chunk,
        isFirst: index === 0,
      });
    }
    if (params.infoKind === "final") {
      deliveredFinalTexts.add(params.text);
    }
    return lastResult;
  };

  const sendMediaReplies = async (
    payload: ReplyPayload,
  ): Promise<{ messageId?: string } | undefined> => {
    let lastResult: { messageId?: string } | undefined;
    for (const mediaUrl of resolveSendableOutboundReplyParts(payload).mediaUrls) {
      lastResult = await sendMediaFeishu({
        cfg,
        to: chatId,
        mediaUrl,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        accountId,
        ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
      });
    }
    return lastResult;
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
        const text = reply.text;
        const hasText = reply.hasText;
        const hasMedia = reply.hasMedia;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;
        let delivered = false;
        let messageId: string | undefined;
        let skipFailureHook = false;

        try {
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
                queueStreamingUpdate(text, { mode: "delta", dedupeWithLastPartial: true });
              }
              if (info?.kind === "final") {
                streamText = text;
                snapshotBaseText = "";
                lastSnapshotTextLength = text.length;
                flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
              }
              // Send media even when streaming handled the text. The final
              // message:sent emission happens when the streaming card closes.
              if (hasMedia) {
                try {
                  await sendMediaReplies(payload);
                } catch (error) {
                  if (streamText && !streamingSentHookEmitted) {
                    await closeStreaming({ emitMessageSent: true });
                    skipFailureHook = true;
                  }
                  throw error;
                }
              }
              return;
            }

            if (useCard) {
              const cardHeader = resolveCardHeader(agentId, identity);
              const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
              const result = await sendChunkedTextReply({
                text,
                useCard: true,
                infoKind: info?.kind,
                sendChunk: async ({ chunk, isFirst }) =>
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
                  }),
              });
              messageId = result?.messageId;
              delivered = true;
            } else {
              const result = await sendChunkedTextReply({
                text,
                useCard: false,
                infoKind: info?.kind,
                sendChunk: async ({ chunk, isFirst }) =>
                  await sendMessageFeishu({
                    cfg,
                    to: chatId,
                    text: chunk,
                    replyToMessageId: sendReplyToMessageId,
                    replyInThread: effectiveReplyInThread,
                    mentions: isFirst ? mentionTargets : undefined,
                    accountId,
                  }),
              });
              messageId = result?.messageId;
              delivered = true;
            }
          }

          if (hasMedia) {
            const result = await sendMediaReplies(payload);
            messageId = result?.messageId ?? messageId;
            delivered = true;
          }

          if (delivered) {
            emitMessageSent({
              content: text,
              success: true,
              messageId,
            });
          }
        } catch (error) {
          if (!skipFailureHook) {
            emitMessageSent({
              content: text,
              success: false,
              error: formatHookError(error),
            });
          }
          throw error;
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
        await closeStreaming({ emitMessageSent: true });
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
            const cleaned = stripReasoningTagsFromText(payload.text, {
              mode: "strict",
              trim: "both",
            });
            if (!cleaned) {
              return;
            }
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
            queueReasoningUpdate(payload.text);
          }
        : undefined,
      onReasoningEnd: reasoningPreviewEnabled ? () => {} : undefined,
      onToolStart: streamingEnabled
        ? (payload: { name?: string; phase?: string }) => {
            updateStreamingStatusLine(
              `🔧 **Using: ${payload.name ?? payload.phase ?? "tool"}...**`,
            );
          }
        : undefined,
      onAssistantMessageStart: streamingEnabled
        ? () => {
            updateStreamingStatusLine("");
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
    markDispatchIdle,
  };
}
