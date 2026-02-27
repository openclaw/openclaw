import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, identity }) => {
    const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
    const renderMode = account.config?.renderMode ?? "auto";
    const useCard = renderMode === "card" || (renderMode === "auto" && /```[\s\S]*?```/.test(text));
    if (useCard) {
      const header = identity
        ? {
            title: identity.emoji
              ? `${identity.emoji} ${identity.name ?? ""}`.trim()
              : (identity.name ?? ""),
            template: "blue" as const,
          }
        : undefined;
      const result = await sendStructuredCardFeishu({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        header: header?.title ? header : undefined,
      });
      return { channel: "feishu", ...result };
    }
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
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
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
