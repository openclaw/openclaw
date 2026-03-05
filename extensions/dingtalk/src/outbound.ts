import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage, sendMarkdownMessage, sendMessageDingtalk } from "./send.js";
import { containsMarkdown } from "./text-utils.js";

const GROUP_CID_RE = /^cid[A-Za-z0-9+/=]+$/;

function resolveOutboundTarget(to: string): {
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
} {
  if (GROUP_CID_RE.test(to)) {
    return { conversationType: "2", conversationId: to, senderStaffId: "" };
  }
  return { conversationType: "1", conversationId: "", senderStaffId: to };
}

// 钉钉出站适配器 / DingTalk outbound adapter
export const dingtalkOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getDingtalkRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 2000,

  sendText: async ({ cfg, to, text, accountId }) => {
    const account = resolveDingtalkAccount({ cfg, accountId: accountId ?? undefined });
    const target = resolveOutboundTarget(to);
    const useMarkdown = containsMarkdown(text);

    if (useMarkdown) {
      const result = await sendMarkdownMessage({
        account,
        ...target,
        title: "Message",
        text,
      });
      return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
    }

    const result = await sendTextMessage({
      account,
      ...target,
      text,
    });
    return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const account = resolveDingtalkAccount({ cfg, accountId: accountId ?? undefined });
    const target = resolveOutboundTarget(to);

    if (text?.trim()) {
      const useMarkdown = containsMarkdown(text);
      if (useMarkdown) {
        await sendMarkdownMessage({
          account,
          ...target,
          title: "Message",
          text,
        });
      } else {
        await sendTextMessage({
          account,
          ...target,
          text,
        });
      }
    }

    if (mediaUrl) {
      const result = await sendTextMessage({
        account,
        ...target,
        text: `[File] ${mediaUrl}`,
      });
      return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
    }

    return { channel: "dingtalk", messageId: "" };
  },
};
