/**
 * MessageSender 工厂
 *
 * 封装 C2C/群聊差异，对外暴露统一的 sendText/sendMedia/sendSticker/sendRaw/send/deliver 接口。
 * 由 prepareSender 中间件调用，将创建好的 sender 注入到 PipelineContext。
 *
 * 各 send 方法的具体实现分别位于 actions Directory下：
 * - sendText    → actions/text/send.ts
 * - sendMedia   → actions/media/send.ts
 * - sendSticker → actions/sticker/send.ts
 * - deliver     → actions/deliver.ts（底层投递，直接调用 transport）
 */

// import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { deliver, type DeliverTarget } from "../actions/deliver.js";
import { sendMedia } from "../actions/media/send.js";
import { sendSticker } from "../actions/sticker/send.js";
import { sendText } from "../actions/text/send.js";
import type { MessageSender, SendParams } from "./types.js";

/**
 * Create message sender
 *
 * 封装 C2C/群聊差异，对外暴露统一的 sendText/sendMedia/sendSticker/sendRaw/send/deliver 接口。
 * 各 send 方法委托给 actions Directory下的对应模块实现。
 */
export function createMessageSender(params: SendParams): MessageSender {
  const {
    isGroup,
    groupCode,
    account,
    target,
    fromAccount,
    refMsgId,
    refFromAccount,
    wsClient,
    core,
    traceContext,
  } = params;

  // 构建投递目标上下文
  const dt: DeliverTarget = {
    isGroup,
    groupCode,
    account,
    target,
    fromAccount,
    refMsgId,
    refFromAccount,
    wsClient,
    traceContext,
  };

  const sender: MessageSender = {
    sendText(text) {
      return sendText({ text, dt });
    },

    sendMedia(mediaUrl, fallbackText) {
      return sendMedia({
        mediaUrl,
        fallbackText,
        core,
        dt,
        sendTextFallback: (t) => sender.sendText(t),
      });
    },

    sendSticker(stickerId) {
      return sendSticker({ stickerId, dt });
    },

    async sendRaw(msgBody) {
      return deliver(dt, msgBody);
    },

    async send(item) {
      switch (item.type) {
        case "text":
          return sender.sendText(item.text);
        case "media":
          return sender.sendMedia(item.mediaUrl, item.fallbackText);
        case "sticker":
          return sender.sendSticker(item.stickerId);
        case "raw":
          return sender.sendRaw(item.msgBody);
        default:
          throw new Error(`Unknown outbound item type: ${(item as { type: string }).type}`);
      }
    },

    /**
     * 从 SDK OutboundReplyPayload 自动分发到对应的发送方法
     * 配合 dispatchInboundReplyWithBase 的 deliver 回调使用
     */
    async deliver(payload) {
      const text = payload.text?.trim() ?? "";
      const mediaUrls = resolveOutboundMediaUrls(payload);

      // 先发文本
      if (text) {
        await sender.sendText(text);
      }
      // 再逐个发Media
      for (const mediaUrl of mediaUrls) {
        if (mediaUrl) {
          await sender.sendMedia(mediaUrl);
        }
      }
    },
  };

  return sender;
}
