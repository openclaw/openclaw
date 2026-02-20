import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "./types.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const renderMode = feishuCfg?.renderMode ?? "card"; // Default to card for best markdown rendering

    // Only use raw mode when explicitly configured
    const useRaw = renderMode === "raw";

    if (useRaw) {
      const result = await sendMessageFeishu({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
      return { channel: "feishu", ...result };
    } else {
      // Default: use Card 2.0 for full markdown support
      const result = await sendMarkdownCardFeishu({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
      return { channel: "feishu", ...result };
    }
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const renderMode = feishuCfg?.renderMode ?? "card";
    const useRaw = renderMode === "raw";

    const sendTextMessage = useRaw ? sendMessageFeishu : sendMarkdownCardFeishu;

    // Send text first if provided
    if (text?.trim()) {
      await sendTextMessage({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendTextMessage({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendTextMessage({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
