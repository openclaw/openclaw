import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";

import { getDingTalkRuntime } from "./runtime.js";
import { sendMessageDingTalk } from "./send.js";

export const dingtalkOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getDingTalkRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, deps }) => {
    const send =
      deps?.sendDingTalk ?? ((to, text) => sendMessageDingTalk({ cfg, to, text }));
    const result = await send(to, text);
    return { channel: "dingtalk", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, deps }) => {
    const send =
      deps?.sendDingTalk ??
      ((to, text, opts) => sendMessageDingTalk({ cfg, to, text, mediaUrl: opts?.mediaUrl }));
    const result = await send(to, text, { mediaUrl });
    return { channel: "dingtalk", ...result };
  },
};
