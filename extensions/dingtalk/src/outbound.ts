import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage, sendMarkdownMessage, sendMessageDingtalk } from "./send.js";

/**
 * 判断文本是否包含 Markdown 元素 / Detect if text contains Markdown elements
 */
function containsMarkdown(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text) ||
    /^#{1,6}\s/m.test(text) || /\*\*.+?\*\*/.test(text) || /\[.+?\]\(.+?\)/.test(text);
}

// 钉钉出站适配器 / DingTalk outbound adapter
export const dingtalkOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getDingtalkRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 2000,

  sendText: async ({ cfg, to, text, accountId }) => {
    const account = resolveDingtalkAccount({ cfg, accountId: accountId ?? undefined });
    const useMarkdown = containsMarkdown(text);

    if (useMarkdown) {
      const result = await sendMarkdownMessage({
        account,
        // 出站消息默认为单聊 / Outbound messages default to DM
        conversationType: "1",
        conversationId: "",
        senderStaffId: to,
        title: "Message",
        text,
      });
      return { channel: "dingtalk", ...result };
    }

    const result = await sendTextMessage({
      account,
      conversationType: "1",
      conversationId: "",
      senderStaffId: to,
      text,
    });
    return { channel: "dingtalk", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const account = resolveDingtalkAccount({ cfg, accountId: accountId ?? undefined });

    // 先发文本（如果有） / Send text first (if provided)
    if (text?.trim()) {
      const useMarkdown = containsMarkdown(text);
      if (useMarkdown) {
        await sendMarkdownMessage({
          account,
          conversationType: "1",
          conversationId: "",
          senderStaffId: to,
          title: "Message",
          text,
        });
      } else {
        await sendTextMessage({
          account,
          conversationType: "1",
          conversationId: "",
          senderStaffId: to,
          text,
        });
      }
    }

    // 发送媒体链接（作为文本消息降级） / Send media link (fallback as text message)
    if (mediaUrl) {
      const result = await sendTextMessage({
        account,
        conversationType: "1",
        conversationId: "",
        senderStaffId: to,
        text: `[File] ${mediaUrl}`,
      });
      return { channel: "dingtalk", ...result };
    }

    return { channel: "dingtalk" };
  },
};
