import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMessageWeCom } from "./send.js";

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendMessageWeCom({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "wecom", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // WeCom media upload not yet implemented; send text + URL fallback
    const content = [text?.trim(), mediaUrl].filter(Boolean).join("\n");
    const result = await sendMessageWeCom({
      cfg,
      to,
      text: content || "(media)",
      accountId: accountId ?? undefined,
    });
    return { channel: "wecom", ...result };
  },
};
