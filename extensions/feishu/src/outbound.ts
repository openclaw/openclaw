import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { shouldUseCard } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";

/** Resolve renderMode for a specific account or fallback to default */
function resolveRenderMode(
  cfg: Record<string, unknown>,
  accountId?: string,
): "auto" | "card" | "raw" {
  const accountConfig = accountId
    ? (((cfg.channels?.feishu as Record<string, unknown>)?.accounts as Record<string, unknown>)?.[
        accountId
      ] as Record<string, unknown> | undefined)
    : (((cfg.channels?.feishu as Record<string, unknown>)?.accounts as Record<string, unknown>)
        ?.default as Record<string, unknown> | undefined);
  return (
    accountConfig?.renderMode ??
    (cfg.channels?.feishu as Record<string, unknown>)?.renderMode ??
    "auto"
  );
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const renderMode = resolveRenderMode(cfg, accountId);

    // Use card mode when renderMode is "card" or "auto" with card content
    if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
      const result = await sendMarkdownCardFeishu({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
      return { channel: "feishu", ...result };
    }

    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const renderMode = resolveRenderMode(cfg, accountId);
    const useCard = renderMode === "card" || (renderMode === "auto" && text && shouldUseCard(text));

    // Send text first if provided
    if (text?.trim()) {
      if (useCard) {
        await sendMarkdownCardFeishu({ cfg, to, text, accountId: accountId ?? undefined });
      } else {
        await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
      }
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
        // Log error for debugging
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
    if (useCard && text) {
      const result = await sendMarkdownCardFeishu({
        cfg,
        to,
        text: text ?? "",
        accountId: accountId ?? undefined,
      });
      return { channel: "feishu", ...result };
    }

    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
