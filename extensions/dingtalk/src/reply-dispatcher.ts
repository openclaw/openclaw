import type { ReplyPayload } from "openclaw/plugin-sdk/dingtalk";
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

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "dingtalk",
    account.accountId,
    { fallbackLimit: 2000 },
  );
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "dingtalk");

  // Accumulate block text so we can deliver it as fallback if no final arrives
  let accumulatedBlockText = "";

  const sendText = async (text: string) => {
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
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;

        if (info?.kind === "block") {
          accumulatedBlockText += text;
          return;
        }

        // Final or normal delivery resets the block accumulator
        accumulatedBlockText = "";
        await sendText(text);
      },
      onError: async (error, info) => {
        log(`dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`);
      },
      onIdle: async () => {
        if (accumulatedBlockText.trim()) {
          await sendText(accumulatedBlockText);
          accumulatedBlockText = "";
        }
      },
    });

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
  };
}
