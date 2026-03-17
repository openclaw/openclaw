import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu
} from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator } from "./typing.js";
function shouldUseCard(text) {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 6e4;
const MS_EPOCH_MIN = 1e12;
function normalizeEpochMs(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp === void 0 || timestamp <= 0) {
    return void 0;
  }
  return timestamp < MS_EPOCH_MIN ? timestamp * 1e3 : timestamp;
}
function resolveCardHeader(agentId, identity) {
  const name = identity?.name?.trim() || agentId;
  const emoji = identity?.emoji?.trim();
  return {
    title: emoji ? `${emoji} ${name}` : name,
    template: identity?.theme ?? "blue"
  };
}
function resolveCardNote(agentId, identity, prefixCtx) {
  const name = identity?.name?.trim() || agentId;
  const parts = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}
function createFeishuReplyDispatcher(params) {
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
    identity
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? void 0 : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });
  let typingState = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (messageCreateTimeMs !== void 0 && Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS) {
        return;
      }
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) => logTypingFailure({
      log: (message) => params.runtime.log?.(message),
      channel: "feishu",
      action: "start",
      error: err
    }),
    onStopError: (err) => logTypingFailure({
      log: (message) => params.runtime.log?.(message),
      channel: "feishu",
      action: "stop",
      error: err
    })
  });
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4e3
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";
  let streaming = null;
  let streamText = "";
  let lastPartial = "";
  let reasoningText = "";
  const deliveredFinalTexts = /* @__PURE__ */ new Set();
  let partialUpdateQueue = Promise.resolve();
  let streamingStartPromise = null;
  const formatReasoningPrefix = (thinking) => {
    if (!thinking) return "";
    const withoutLabel = thinking.replace(/^Reasoning:\n/, "");
    const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
    const lines = plain.split("\n").map((line) => `> ${line}`);
    return `> \u{1F4AD} **Thinking**
${lines.join("\n")}`;
  };
  const buildCombinedStreamText = (thinking, answer) => {
    const parts = [];
    if (thinking) parts.push(formatReasoningPrefix(thinking));
    if (thinking && answer) parts.push("\n\n---\n\n");
    if (answer) parts.push(answer);
    return parts.join("");
  };
  const flushStreamingCardUpdate = (combined) => {
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(combined);
      }
    });
  };
  const queueStreamingUpdate = (nextText, options) => {
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
    streamText = mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };
  const queueReasoningUpdate = (nextThinking) => {
    if (!nextThinking) return;
    reasoningText = nextThinking;
    flushStreamingCardUpdate(buildCombinedStreamText(reasoningText, streamText));
  };
  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds = account.appId && account.appSecret ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain } : null;
      if (!creds) {
        return;
      }
      streaming = new FeishuStreamingSession(
        createFeishuClient(account),
        creds,
        (message) => params.runtime.log?.(`feishu[${account.accountId}] ${message}`)
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
        streamingStartPromise = null;
      }
    })();
  };
  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = buildCombinedStreamText(reasoningText, streamText);
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
      await streaming.close(text, { note: finalNote });
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
    reasoningText = "";
  };
  const sendChunkedTextReply = async (params2) => {
    let first = true;
    const chunkSource = params2.useCard ? params2.text : core.channel.text.convertMarkdownTables(params2.text, tableMode);
    for (const chunk of core.channel.text.chunkTextWithMode(
      chunkSource,
      textChunkLimit,
      chunkMode
    )) {
      const message = {
        cfg,
        to: chatId,
        text: chunk,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        mentions: first ? mentionTargets : void 0,
        accountId
      };
      if (params2.useCard) {
        await sendMarkdownCardFeishu(message);
      } else {
        await sendMessageFeishu(message);
      }
      first = false;
    }
    if (params2.infoKind === "final") {
      deliveredFinalTexts.add(params2.text);
    }
  };
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
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
    deliver: async (payload, info) => {
      const text = payload.text ?? "";
      const mediaList = payload.mediaUrls && payload.mediaUrls.length > 0 ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
      const hasText = Boolean(text.trim());
      const hasMedia = mediaList.length > 0;
      const skipTextForDuplicateFinal = info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
      const shouldDeliverText = hasText && !skipTextForDuplicateFinal;
      if (!shouldDeliverText && !hasMedia) {
        return;
      }
      if (shouldDeliverText) {
        const useCard = renderMode === "card" || renderMode === "auto" && shouldUseCard(text);
        let first = true;
        if (info?.kind === "block") {
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
            queueStreamingUpdate(text, { mode: "delta" });
          }
          if (info?.kind === "final") {
            streamText = mergeStreamingText(streamText, text);
            await closeStreaming();
            deliveredFinalTexts.add(text);
          }
          if (hasMedia) {
            for (const mediaUrl of mediaList) {
              await sendMediaFeishu({
                cfg,
                to: chatId,
                mediaUrl,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                accountId
              });
            }
          }
          return;
        }
        if (useCard) {
          const cardHeader = resolveCardHeader(agentId, identity);
          const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
          for (const chunk of core.channel.text.chunkTextWithMode(
            text,
            textChunkLimit,
            chunkMode
          )) {
            await sendStructuredCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              mentions: first ? mentionTargets : void 0,
              accountId,
              header: cardHeader,
              note: cardNote
            });
            first = false;
          }
          if (info?.kind === "final") {
            deliveredFinalTexts.add(text);
          }
        } else {
          await sendChunkedTextReply({ text, useCard: false, infoKind: info?.kind });
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
            accountId
          });
        }
      }
    },
    onError: async (error, info) => {
      params.runtime.error?.(
        `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`
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
    }
  });
  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: true,
      onPartialReply: streamingEnabled ? (payload) => {
        if (!payload.text) {
          return;
        }
        queueStreamingUpdate(payload.text, {
          dedupeWithLastPartial: true,
          mode: "snapshot"
        });
      } : void 0,
      onReasoningStream: streamingEnabled ? (payload) => {
        if (!payload.text) {
          return;
        }
        startStreaming();
        queueReasoningUpdate(payload.text);
      } : void 0,
      onReasoningEnd: streamingEnabled ? () => {
      } : void 0
    },
    markDispatchIdle
  };
}
export {
  createFeishuReplyDispatcher
};
