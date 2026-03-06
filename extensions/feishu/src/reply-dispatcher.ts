import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
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

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type GroupReplyMode = "reply" | "create" | "auto";

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
  /**
   * Controls how the bot sends messages in group chats.
   * - "reply": All messages use im.message.reply() (default, current behavior).
   * - "create": All messages use im.message.create() (standalone, pre-2026.3.1 behavior).
   * - "auto": First message per turn uses reply, subsequent use create.
   */
  groupReplyMode?: GroupReplyMode;
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
    groupReplyMode = "reply",
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;

  // Track whether the first message has been sent (for "auto" mode).
  // The flag is only committed when the actual send path is determined
  // (non-streaming text delivery or streaming.start success) to avoid
  // a race where deliver() consumes the flag before the streaming card
  // has a chance to read it.
  let firstMessageSent = false;

  /**
   * Peek at whether this delivery should use reply or create, based on groupReplyMode.
   * Does NOT commit the firstMessageSent flag — call commitFirstMessageSent() after
   * the message is actually sent.
   * Returns the effective replyToMessageId (undefined = use create, string = use reply).
   */
  const resolveEffectiveReplyTo = (): string | undefined => {
    if (groupReplyMode === "create") {
      return undefined;
    }
    if (groupReplyMode === "auto") {
      if (firstMessageSent) {
        return undefined; // subsequent messages → create (standalone)
      }
      return sendReplyToMessageId; // first message → reply (flag committed later)
    }
    // "reply" mode (default): always reply
    return sendReplyToMessageId;
  };

  /** Commit the firstMessageSent flag after the actual send succeeds. */
  const commitFirstMessageSent = () => {
    if (groupReplyMode === "auto") {
      firstMessageSent = true;
    }
  };

  /**
   * Resolve whether streaming card should use reply context, based on groupReplyMode.
   * For "create" mode: no reply context (standalone card, pre-2026.3.1 behavior).
   * For "auto" mode: first streaming card uses reply, subsequent don't.
   * For "reply" mode: always use reply context.
   *
   * Note: this peeks at the flag but does NOT commit it. The streaming start
   * handler commits the flag after the card is successfully created.
   */
  const resolveStreamingReplyOptions = (): {
    replyToMessageId?: string;
    replyInThread?: boolean;
    rootId?: string;
  } => {
    if (groupReplyMode === "create") {
      return {}; // standalone card
    }
    if (groupReplyMode === "auto" && firstMessageSent) {
      return {}; // subsequent cards → standalone
    }
    // "auto" first or "reply" mode — use reply context.
    // Flag is committed after streaming.start() succeeds.
    return { replyToMessageId, replyInThread: effectiveReplyInThread, rootId };
  };
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
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  type StreamTextUpdateMode = "snapshot" | "delta";

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
    streamText =
      mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
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
        await streaming.start(chatId, resolveReceiveIdType(chatId), resolveStreamingReplyOptions());
        // Commit flag only after the streaming card is successfully created,
        // so the flag is not consumed prematurely by deliver() calls that
        // arrive before streaming.start() resolves.
        commitFirstMessageSent();
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        deliveredFinalTexts.clear();
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
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        // Resolve reply target based on groupReplyMode (may be undefined for "create" / "auto" subsequent).
        const deliveryReplyTo = resolveEffectiveReplyTo();
        const deliveryReplyInThread = deliveryReplyTo ? effectiveReplyInThread : undefined;

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
              streamText = mergeStreamingText(streamText, text);
              await closeStreaming();
              deliveredFinalTexts.add(text);
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: deliveryReplyTo,
                  replyInThread: deliveryReplyInThread,
                  accountId,
                });
              }
            }
            return;
          }

          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              // In "auto" mode, only the first chunk replies; subsequent chunks
              // use create to avoid topic-folding every chunk under the parent.
              const chunkReplyTo = first
                ? deliveryReplyTo
                : groupReplyMode === "auto"
                  ? undefined
                  : deliveryReplyTo;
              const chunkReplyInThread = chunkReplyTo ? deliveryReplyInThread : undefined;
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: chunkReplyTo,
                replyInThread: chunkReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              if (first) {
                commitFirstMessageSent();
                first = false;
              }
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              // In "auto" mode, only the first chunk replies; subsequent chunks
              // use create to avoid topic-folding every chunk under the parent.
              const chunkReplyTo = first
                ? deliveryReplyTo
                : groupReplyMode === "auto"
                  ? undefined
                  : deliveryReplyTo;
              const chunkReplyInThread = chunkReplyTo ? deliveryReplyInThread : undefined;
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: chunkReplyTo,
                replyInThread: chunkReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              if (first) {
                commitFirstMessageSent();
                first = false;
              }
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          }
        }

        if (hasMedia) {
          let mediaFirst = true;
          for (const mediaUrl of mediaList) {
            // When only media is sent (no text), the first media acts as
            // the "first message" for auto mode.
            const mediaReplyTo = mediaFirst
              ? deliveryReplyTo
              : groupReplyMode === "auto" && !hasText
                ? undefined
                : deliveryReplyTo;
            const mediaReplyInThread = mediaReplyTo ? deliveryReplyInThread : undefined;
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: mediaReplyTo,
              replyInThread: mediaReplyInThread,
              accountId,
            });
            if (mediaFirst) {
              commitFirstMessageSent();
              mediaFirst = false;
            }
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
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
    },
    markDispatchIdle,
  };
}
