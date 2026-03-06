import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/lanxin";
import { resolveLanxinAccount } from "./accounts.js";
import { logLanxinDebug } from "./debug.js";
import { uploadLanxinMediaFromUrl } from "./media.js";
import { getLanxinRuntime } from "./runtime.js";
import { sendMessageLanxin } from "./send.js";

export const lanxinOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLanxinRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const account = resolveLanxinAccount({ cfg, accountId });
    if (!account.configured) {
      throw new Error("Lanxin not configured");
    }
    logLanxinDebug(cfg, "outbound sendText", {
      to,
      accountId,
      textLength: text.length,
    });
    const result = await sendMessageLanxin({ cfg, to, text, accountId });
    return { channel: "lanxin", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId }) => {
    const account = resolveLanxinAccount({ cfg, accountId });
    if (!account.configured) {
      throw new Error("Lanxin not configured");
    }
    logLanxinDebug(cfg, "outbound sendMedia start", {
      to,
      accountId,
      mediaUrl,
      textLength: (text ?? "").length,
    });
    if (!mediaUrl) {
      const result = await sendMessageLanxin({
        cfg,
        to,
        text: text?.trim() || "[media]",
        accountId,
      });
      return { channel: "lanxin", ...result };
    }

    const uploaded = await uploadLanxinMediaFromUrl({
      cfg,
      accountId,
      mediaUrl,
      mediaLocalRoots,
    });
    logLanxinDebug(cfg, "outbound sendMedia upload result", uploaded);
    const result = await sendMessageLanxin({
      cfg,
      to,
      text: text?.trim() || "",
      accountId,
      // Keep msgType=text for compatibility with known working Lanxin bot behavior.
      msgType: "text",
      mediaType: uploaded.fileType,
      mediaIds: [uploaded.mediaId],
    });
    logLanxinDebug(cfg, "outbound sendMedia send result", result);
    return { channel: "lanxin", ...result };
  },
};
