import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text }) => {
    const result = await sendMessageFeishu({ cfg, to, text });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({ cfg, to, mediaUrl });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({ cfg, to, text: fallbackText });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({ cfg, to, text: text ?? "" });
    return { channel: "feishu", ...result };
  },
};
