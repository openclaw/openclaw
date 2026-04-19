/**
 * MessageSender factory.
 *
 * Wraps C2C/group differences behind a unified sendText/sendMedia/sendSticker/sendRaw/send/deliver interface.
 * Called by prepareSender middleware to inject the sender into PipelineContext.
 *
 * Each send method is implemented in the actions directory:
 * - sendText    → actions/text/send.ts
 * - sendMedia   → actions/media/send.ts
 * - sendSticker → actions/sticker/send.ts
 * - deliver     → actions/deliver.ts (low-level transport)
 */

// import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { deliver, type DeliverTarget } from "../actions/deliver.js";
import { sendMedia } from "../actions/media/send.js";
import { sendSticker } from "../actions/sticker/send.js";
import { sendText } from "../actions/text/send.js";
import type { MessageSender, SendParams } from "./types.js";

/**
 * Create message sender.
 *
 * Wraps C2C/group differences behind a unified send interface.
 * Each send method delegates to the corresponding module in the actions directory.
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

    // Build delivery target context
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
     * Auto-dispatch from SDK OutboundReplyPayload to the corresponding send method.
     * Used with dispatchInboundReplyWithBase's deliver callback.
     */
    async deliver(payload) {
      const text = payload.text?.trim() ?? "";
      const mediaUrls = resolveOutboundMediaUrls(payload);

      // Send text first
      if (text) {
        await sender.sendText(text);
      }
      // Then send media one by one
      for (const mediaUrl of mediaUrls) {
        if (mediaUrl) {
          await sender.sendMedia(mediaUrl);
        }
      }
    },
  };

  return sender;
}
