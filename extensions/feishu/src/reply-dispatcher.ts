import path from "path";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { registerStreamAppender, unregisterStreamAppender } from "./active-streams.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu, uploadImageFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"]);

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  /** The normalized outbound target (e.g. `ou_xxx` for P2P). Used as alias key for stream lookup. */
  outboundTo?: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    outboundTo,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    rootId,
    mentionTargets,
    accountId,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
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
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  // Accumulated text from completed assistant messages (before tool calls / new messages).
  let committedText = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  // Track already-embedded media URLs to prevent duplicate uploads.
  const embeddedMediaUrls = new Set<string>();
  // Mirrors the framework's `didSendViaMessagingTool` suppression for onPartialReply.
  // When the outbound adapter (message tool) writes to the streaming card, post-tool
  // AI confirmation text (e.g. "NO") is suppressed — the framework already suppresses
  // it for onBlockReply but not for onPartialReply.
  let outboundAppended = false;

  /** Append content (e.g. text or `![image](key)`) to the active streaming card.
   *  Commits current partial first so the appended content survives onPartialReply rebuilds. */
  const appendToStream = (content: string) => {
    if (lastPartial) {
      committedText += (committedText ? "\n\n" : "") + lastPartial;
      lastPartial = "";
    }
    committedText += content;
    streamText = committedText;
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
  };

  /** Upload media URLs and embed images into the streaming card. */
  const embedMediaInStream = async (urls: string[]): Promise<void> => {
    const runtime = getFeishuRuntime();
    for (const url of urls) {
      if (embeddedMediaUrls.has(url)) {
        continue;
      }
      embeddedMediaUrls.add(url);
      try {
        const loaded = await runtime.media.loadWebMedia(url, {
          maxBytes: 30 * 1024 * 1024,
          optimizeImages: false,
        });
        const ext = path.extname(loaded.fileName ?? "file").toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          const { imageKey } = await uploadImageFeishu({
            cfg,
            image: loaded.buffer,
            accountId,
          });
          appendToStream(`\n![image](${imageKey})\n`);
        }
      } catch (err) {
        params.runtime.error?.(`feishu: embed media failed for ${url}: ${String(err)}`);
      }
    }
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
          replyInThread,
          rootId,
        });
        const externalAppender = (content: string) => {
          outboundAppended = true;
          appendToStream(content);
        };
        registerStreamAppender(chatId, externalAppender, outboundTo ? [outboundTo] : undefined);
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    unregisterStreamAppender(chatId);
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
    committedText = "";
    embeddedMediaUrls.clear();
    outboundAppended = false;
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
        const allMediaUrls = [
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ];
        const mediaUrls = allMediaUrls.length ? allMediaUrls : undefined;
        if (!text.trim() && !mediaUrls) {
          return;
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (streaming?.isActive()) {
          // Embed media into the streaming card
          if (mediaUrls) {
            await embedMediaInStream(mediaUrls);
          }
          if (info?.kind === "final") {
            if (outboundAppended && committedText) {
              streamText = committedText;
            } else {
              if (lastPartial && !text.startsWith(lastPartial)) {
                committedText += (committedText ? "\n\n" : "") + lastPartial;
              }
              streamText = committedText ? committedText + "\n\n" + text : text;
            }
            await closeStreaming();
          }
          return;
        }

        // Not streaming: send media as separate messages
        if (mediaUrls) {
          for (const url of mediaUrls) {
            try {
              await sendMediaFeishu({
                cfg,
                to: chatId,
                mediaUrl: url,
                replyToMessageId: sendReplyToMessageId,
                replyInThread,
                accountId,
              });
            } catch (err) {
              params.runtime.error?.(`feishu: send media failed: ${String(err)}`);
            }
          }
        }

        if (!text.trim()) {
          return;
        }

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
              replyInThread,
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
              replyInThread,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
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
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            // Handle media URLs from streaming directives
            if (payload.mediaUrls?.length && streaming?.isActive()) {
              void embedMediaInStream(payload.mediaUrls);
            }
            if (!payload.text || payload.text === lastPartial) {
              return;
            }
            // Suppress the post-tool confirmation message (e.g. "NO") when the
            // outbound adapter wrote to the card. Track the suppressed text via
            // lastPartial; when a genuinely new message starts, reset the flag so
            // subsequent AI text flows normally (fixes multi-tool-call sessions).
            if (outboundAppended) {
              if (!lastPartial || payload.text.startsWith(lastPartial)) {
                lastPartial = payload.text;
                return;
              }
              outboundAppended = false;
              lastPartial = "";
            }
            const isNewMessage = Boolean(lastPartial && !payload.text.startsWith(lastPartial));
            if (isNewMessage) {
              committedText += (committedText ? "\n\n" : "") + lastPartial;
            }
            lastPartial = payload.text;
            streamText = committedText ? committedText + "\n\n" + payload.text : payload.text;
            partialUpdateQueue = partialUpdateQueue.then(async () => {
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
              if (streaming?.isActive()) {
                await streaming.update(streamText);
              }
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
