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
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/**
 * Check if the accumulated markdown text is "safe" to render — i.e. it has
 * no unclosed fenced code blocks (```) that would cause Feishu to crash/blank.
 * We ONLY check for balanced code fences. We do NOT require text to end at
 * a paragraph boundary — that was too strict and blocked all streaming updates.
 */
function isSafeToRender(text: string): boolean {
  if (!text.trim()) return false;
  // Count code fences (``` at start of line or after whitespace): odd = unclosed
  let fenceCount = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      fenceCount++;
    }
  }
  // Odd fence count means there's an unclosed code block — not safe
  return fenceCount % 2 === 0;
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
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
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
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
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  // --- CardKit streaming with block-boundary guard ---
  // We use the original CardKit streaming session, but ONLY call
  // streaming.update() when the accumulated text is "safe" to render:
  // - No unclosed code fences (```)
  // - Text ends at a paragraph boundary (\n\n) or closed code block
  // This prevents the markdown crash/blank card bug while keeping the
  // single-card progressive update experience.
  let streaming: FeishuStreamingSession | null = null;
  let streamText = ""; // current card's text (sliced from cumulative)
  let lastSafeText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let blockOffset = 0; // cumulative char offset: text before this was delivered in previous blocks

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
    lastSafeText = "";
    lastPartial = "";
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

          // For block events, feed the streaming card if active
          if (info?.kind === "block") {
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          // For final events, ensure streaming is started if applicable
          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          // If streaming card is active, handle via CardKit
          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Coalesced block boundary (merged by core SDK's block-reply-coalescer).
              // Close the current streaming card with the per-block text.
              // Then advance blockOffset so the next card starts fresh.
              streamText = text;
              await closeStreaming();
              blockOffset += text.length;
            }
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming();
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

          // No streaming card active
          // If kind=final after blocks were delivered, only send undelivered tail text
          if (info?.kind === "final" && blockOffset > 0) {
            const tailText = text.length > blockOffset ? text.slice(blockOffset).trim() : "";
            if (!tailText) {
              // All text was already delivered via blocks — nothing more to send
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
            // Send only the undelivered tail as a discrete card
            if (useCard) {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: tailText,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: mentionTargets,
                accountId,
              });
            } else {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: tailText,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: mentionTargets,
                accountId,
              });
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
            return;
          }

          // No streaming card — send as discrete cards (fallback)
          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
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
      // Block-boundary guarded streaming: accumulate partial text, but only
      // push to CardKit when the markdown is safe (no unclosed code fences,
      // text ends at paragraph boundary). This prevents blank card flashes.
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            if (payload.text === lastPartial) {
              return;
            }
            lastPartial = payload.text;

            // Slice cumulative text from blockOffset: each card only shows its block's content
            const cardText = blockOffset > 0 ? payload.text.slice(blockOffset) : payload.text;
            streamText = cardText;

            // Don't start a new streaming card if there's no new content beyond delivered blocks
            if (!streaming?.isActive() && blockOffset > 0 && cardText.trim().length === 0) {
              return;
            }

            // Start streaming if not already started
            startStreaming();

            // Only push update to CardKit when text is safe to render
            if (isSafeToRender(cardText) && cardText !== lastSafeText) {
              lastSafeText = cardText;
              const updateText = cardText;
              partialUpdateQueue = partialUpdateQueue.then(async () => {
                if (streamingStartPromise) {
                  await streamingStartPromise;
                }
                if (streaming?.isActive()) {
                  await streaming.update(updateText);
                }
              });
            }
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
