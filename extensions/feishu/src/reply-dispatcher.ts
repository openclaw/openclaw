import {
  createReplyPrefixContext,
  createTypingCallbacks,
  emitMessageSent,
  logTypingFailure,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { resolveFeishuAccount } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { createFeishuStreamingController } from "./streaming-controller.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering. */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function stripSummarySpecialTags(text: string): string {
  return text
    .replace(/<at\b[^>]*\/>/gi, " ")
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, "$1")
    .replace(/<at\b[^>]*>/gi, " ")
    .replace(/<\/at>/gi, " ");
}

function firstSentence(text: string): string {
  const normalized = stripSummarySpecialTags(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Generating ...";
  }
  const match = normalized.match(/^(.{1,120}?[。！？.!?])(\s|$)/);
  if (match?.[1]) {
    return match[1].trim();
  }
  return normalized.slice(0, 120).trim();
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  disableBlockStreaming?: boolean;
  enableThinkingCard?: boolean;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    mentionTargets,
    accountId,
    disableBlockStreaming,
  } = params;

  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
      params.runtime.log?.(`feishu[${account.accountId}]: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      params.runtime.log?.(`feishu[${account.accountId}]: removed typing indicator reaction`);
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

  const feishuCfg = account.config;
  const renderMode = feishuCfg?.renderMode ?? "auto";
  const streamRenderMode = renderMode === "raw" ? "raw" : "card";
  const trueStreamingEnabled = feishuCfg?.streaming !== false;
  const blockStreamingConfigured = feishuCfg?.blockStreaming !== false;
  const blockStreamingEnabled = blockStreamingConfigured && disableBlockStreaming !== true;
  const thinkingCardEnabled = params.enableThinkingCard !== false;
  const configuredStreamMethod = trueStreamingEnabled
    ? streamRenderMode === "card"
      ? "cardkit.cardElement.content"
      : "im.message.update"
    : "disabled";

  params.runtime.log?.(
    `feishu[${account.accountId}] streaming config: enabled=${trueStreamingEnabled}, renderMode=${renderMode}, streamRenderMode=${streamRenderMode}, blockStreamingConfigured=${blockStreamingConfigured}, blockStreamingEnabled=${blockStreamingEnabled}, method=${configuredStreamMethod}`,
  );

  const streamingController = createFeishuStreamingController({
    cfg,
    runtime: params.runtime,
    accountId,
    accountLabel: account.accountId,
    chatId,
    replyToMessageId,
    mentionTargets,
    streamRenderMode,
    trueStreamingEnabled,
    blockStreamingEnabled,
    thinkingCardEnabled,
    summarize: firstSentence,
  });

  const notifyMessageSent = (
    content: string,
    messageId?: string,
    metadata?: { msgType?: "text" | "post" | "interactive" },
  ): void => {
    emitMessageSent(
      { to: chatId, content, success: true, messageId, metadata },
      { channelId: "feishu", accountId: account.accountId, conversationId: chatId },
    );
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (
        payload: ReplyPayload,
        info?: { kind?: "tool" | "block" | "final" },
      ): Promise<void> => {
        const text = payload.text ?? "";
        if (!text) {
          return;
        }

        if (info?.kind === "final") {
          const streamedFinal = await streamingController.tryDeliverFinalStream(text);
          if (streamedFinal.handled) {
            notifyMessageSent(text, streamedFinal.messageId, { msgType: streamedFinal.msgType });
            return;
          }
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
        if (useCard && (info?.kind === "block" || info?.kind === "final")) {
          const blockResult = await streamingController.tryDeliverBlock(text);
          if (blockResult.handled) {
            if (blockResult.messageId) {
              notifyMessageSent(text, blockResult.messageId, { msgType: "interactive" });
            }
            return;
          }
        }

        let isFirstChunk = true;
        let firstMessageId: string | undefined;
        if (useCard) {
          for (const chunk of core.channel.text.chunkTextWithMode(
            text,
            textChunkLimit,
            chunkMode,
          )) {
            const result = await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            firstMessageId ??= result.messageId;
            isFirstChunk = false;
          }
        } else {
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          for (const chunk of core.channel.text.chunkTextWithMode(
            converted,
            textChunkLimit,
            chunkMode,
          )) {
            const result = await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            firstMessageId ??= result.messageId;
            isFirstChunk = false;
          }
        }
        notifyMessageSent(text, firstMessageId, { msgType: useCard ? "interactive" : "post" });
      },
      onError: async (err, info): Promise<void> => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
        await streamingController.closeStreamingIfNeeded();
        typingCallbacks.onIdle?.();
      },
      onIdle: async (): Promise<void> => {
        await streamingController.closeStreamingIfNeeded();
        typingCallbacks.onIdle?.();
      },
      onCleanup: async (): Promise<void> => {
        typingCallbacks.onCleanup?.();
        await streamingController.clearPendingThinkingCard();
        await streamingController.closeStreamingIfNeeded();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: async (ctx: Parameters<typeof prefixContext.onModelSelected>[0]) => {
        await streamingController.ensureThinkingCardIfNeeded();
        prefixContext.onModelSelected(ctx);
      },
      disableBlockStreaming: streamingController.getReplyDisableBlockStreamingFlag(),
      onPartialReply: streamingController.trueStreamingEnabled
        ? (payload: ReplyPayload) => {
            const text = payload.text ?? "";
            if (!text) {
              return;
            }
            streamingController.queuePartialReply(text);
          }
        : undefined,
    },
    markDispatchIdle,
    finalizeThinkingCard: streamingController.clearPendingThinkingCard,
  };
}
