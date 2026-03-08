/**
 * DingTalk outbound adapter
 *
 * Implements ChannelOutboundAdapter interface, provides:
 * - sendText: send text messages
 * - sendMedia: send media messages (with fallback logic)
 * - chunker: long message chunking (using Moltbot core's markdown-aware chunking)
 *
 * Config:
 * - deliveryMode: "direct" (send directly, no queue)
 * - textChunkLimit: 4000 (DingTalk Markdown message max characters)
 * - chunkerMode: "markdown" (use markdown-aware chunking mode)
 */

import type { ChannelOutboundAdapter, ChannelOutboundContext } from "openclaw/plugin-sdk/dingtalk";
import type { OutboundDeliveryResult } from "../../../src/infra/outbound/deliver.js";
import { sendMediaDingtalk } from "./media.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
/**
 * Parse target ID and chat type
 */
function parseTarget(to: string): { targetId: string; chatType: "direct" | "group" } {
  if (to.startsWith("chat:")) {
    return { targetId: to.slice(5), chatType: "group" };
  }
  if (to.startsWith("user:")) {
    return { targetId: to.slice(5), chatType: "direct" };
  }
  return { targetId: to, chatType: "direct" };
}

export const dingtalkOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  /**
   * Long message chunker
   * Uses Moltbot core's markdown-aware chunking, won't break in the middle of code blocks
   */
  chunker: (text: string, limit: number): string[] => {
    try {
      const runtime = getDingtalkRuntime();
      if (runtime.channel?.text?.chunkMarkdownText) {
        return runtime.channel.text.chunkMarkdownText(text, limit);
      }
    } catch {
      // runtime not initialized, return original text for Moltbot core to handle
    }
    return [text];
  },

  /**
   * Send text message
   */
  sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text } = ctx;

    const dingtalkCfg = cfg.channels?.dingtalk;
    if (!dingtalkCfg) {
      throw new Error("DingTalk channel not configured");
    }

    const { targetId, chatType } = parseTarget(to);

    const result = await sendMessageDingtalk({
      cfg: dingtalkCfg,
      to: targetId,
      text,
      chatType,
    });

    return {
      channel: "dingtalk",
      messageId: result.messageId,
      chatId: result.conversationId,
      conversationId: result.conversationId,
    };
  },

  /**
   * Send media message (with fallback logic)
   */
  sendMedia: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text, mediaUrl } = ctx;

    const dingtalkCfg = cfg.channels?.dingtalk;
    if (!dingtalkCfg) {
      throw new Error("DingTalk channel not configured");
    }

    const { targetId, chatType } = parseTarget(to);

    // Send text first (if any)
    if (text?.trim()) {
      await sendMessageDingtalk({
        cfg: dingtalkCfg,
        to: targetId,
        text,
        chatType,
      });
    }

    // Send media (if URL provided)
    if (mediaUrl) {
      try {
        const result = await sendMediaDingtalk({
          cfg: dingtalkCfg,
          to: targetId,
          mediaUrl,
          chatType,
        });

        return {
          channel: "dingtalk",
          messageId: result.messageId,
          chatId: result.conversationId,
          conversationId: result.conversationId,
        };
      } catch (err) {
        // Log error and fallback to URL text link
        console.error(`[dingtalk] sendMediaDingtalk failed:`, err);

        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageDingtalk({
          cfg: dingtalkCfg,
          to: targetId,
          text: fallbackText,
          chatType,
        });

        return {
          channel: "dingtalk",
          messageId: result.messageId,
          chatId: result.conversationId,
          conversationId: result.conversationId,
        };
      }
    }

    // No media URL, return placeholder result
    return {
      channel: "dingtalk",
      messageId: text?.trim() ? `text_${Date.now()}` : "empty",
      chatId: targetId,
      conversationId: targetId,
    };
  },
};
