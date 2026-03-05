import { createReplyPrefixContext, type ReplyPayload } from "openclaw/plugin-sdk/dingtalk";
import { sendDingtalkCard, updateDingtalkCard } from "./card.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage, sendMarkdownMessage } from "./send.js";
import { containsMarkdown } from "./text-utils.js";
import type { DingtalkMessageContext, ResolvedDingtalkAccount } from "./types.js";

/**
 * 创建钉钉回复分发器 / Create DingTalk reply dispatcher
 */
export function createDingtalkReplyDispatcher(params: {
  cfg: import("openclaw/plugin-sdk/dingtalk").ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  ctx: DingtalkMessageContext;
  log: (...args: unknown[]) => void;
}) {
  const { cfg, account, ctx, log } = params;
  const core = getDingtalkRuntime();
  const streamingEnabled = account.config?.streaming !== false;

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "dingtalk",
    account.accountId,
    { fallbackLimit: 2000 },
  );
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "dingtalk");

  // 流式卡片状态 / Streaming card state
  let cardBizId: string | null = null;
  let streamText = "";
  let lastPartial = "";
  let streamingStartPromise: Promise<void> | null = null;
  let partialUpdateQueue: Promise<void> = Promise.resolve();

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || cardBizId) return;
    streamingStartPromise = (async () => {
      try {
        const result = await sendDingtalkCard({
          account,
          conversationType: ctx.conversationType,
          conversationId: ctx.conversationId,
          senderStaffId: ctx.senderStaffId,
          content: "...",
        });
        cardBizId = result.cardBizId;
      } catch (err) {
        log(`dingtalk[${account.accountId}]: streaming card start failed: ${err}`);
        cardBizId = null;
      }
    })();
  };

  const queueStreamingUpdate = (text: string, accumulate = false) => {
    if (!text || text === lastPartial) return;
    lastPartial = text;
    streamText = accumulate ? streamText + text : text;
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) await streamingStartPromise;
      if (cardBizId) {
        try {
          await updateDingtalkCard({
            account,
            cardBizId,
            content: streamText,
          });
        } catch (err) {
          log(`dingtalk[${account.accountId}]: streaming card update failed: ${err}`);
        }
      }
    });
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) await streamingStartPromise;
    await partialUpdateQueue;
    if (cardBizId && streamText) {
      try {
        await updateDingtalkCard({
          account,
          cardBizId,
          content: streamText,
        });
      } catch (err) {
        log(`dingtalk[${account.accountId}]: streaming card final update failed: ${err}`);
      }
    }
    cardBizId = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;

        // 流式输出中的 block/final 处理 / Handle block/final in streaming
        if (streamingEnabled && info?.kind === "block") {
          startStreaming();
          queueStreamingUpdate(text, true);
          return;
        }

        if (streamingEnabled && info?.kind === "final" && cardBizId) {
          streamText = text;
          await closeStreaming();
          return;
        }

        // 非流式回复 / Non-streaming reply
        const useMarkdown = containsMarkdown(text);
        for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
          if (useMarkdown) {
            await sendMarkdownMessage({
              account,
              conversationType: ctx.conversationType,
              conversationId: ctx.conversationId,
              senderStaffId: ctx.senderStaffId,
              title: "Reply",
              text: chunk,
            });
          } else {
            await sendTextMessage({
              account,
              conversationType: ctx.conversationType,
              conversationId: ctx.conversationId,
              senderStaffId: ctx.senderStaffId,
              text: chunk,
            });
          }
        }
      },
      onError: async (error, info) => {
        log(`dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);
        await closeStreaming();
      },
      onIdle: async () => {
        await closeStreaming();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) return;
            queueStreamingUpdate(payload.text);
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
