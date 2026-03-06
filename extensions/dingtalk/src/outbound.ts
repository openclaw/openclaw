import * as fs from "node:fs";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { uploadMedia, sendImageMessage, sendFileMessage } from "./media.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendTextMessage, sendMarkdownMessage, sendMessageDingtalk } from "./send.js";
import { containsMarkdown } from "./text-utils.js";

const GROUP_CID_RE = /^cid[A-Za-z0-9+/=]+$/;

function resolveOutboundTarget(to: string): {
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
} {
  // Explicit prefix from normalizeDingtalkTarget
  if (to.startsWith("group:")) {
    return { conversationType: "2", conversationId: to.slice(6), senderStaffId: "" };
  }
  if (to.startsWith("user:")) {
    return { conversationType: "1", conversationId: "", senderStaffId: to.slice(5) };
  }
  // Heuristic fallback for bare IDs
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
      const isLocal =
        mediaUrl.startsWith("file://") ||
        mediaUrl.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(mediaUrl);

      if (isLocal) {
        const filePath = mediaUrl.startsWith("file://") ? mediaUrl.slice(7) : mediaUrl;
        if (fs.existsSync(filePath)) {
          const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath);
          const mediaType = isImage ? "image" : "file";
          const mediaId = await uploadMedia({ account, filePath, type: mediaType });
          if (isImage) {
            const result = await sendImageMessage({
              account,
              ...target,
              photoURL: `@lADPDe7s${mediaId}`,
            });
            return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
          }
          const result = await sendFileMessage({
            account,
            ...target,
            mediaId,
            fileName: filePath.split(/[\\/]/).pop() ?? "file",
            fileType: filePath.split(".").pop() ?? "bin",
          });
          return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
        }
      }

      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(mediaUrl);
      if (isImage) {
        const result = await sendImageMessage({
          account,
          ...target,
          photoURL: mediaUrl,
        });
        return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
      }

      const result = await sendMarkdownMessage({
        account,
        ...target,
        title: "File",
        text: `[Download file](${mediaUrl})`,
      });
      return { channel: "dingtalk", messageId: result.processQueryKey ?? "", ...result };
    }

    return { channel: "dingtalk", messageId: "" };
  },
};
