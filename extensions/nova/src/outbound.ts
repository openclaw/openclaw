import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getNovaRuntime } from "./runtime.js";
import { sendNovaMessage } from "./send.js";

export const novaOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getNovaRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text }) => {
    const result = sendNovaMessage({ cfg, to, text, done: true });
    return { channel: "nova", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    // Send text with media URL inline (no native media embedding yet)
    const body = mediaUrl ? `${text}\n${mediaUrl}` : text;
    const result = sendNovaMessage({ cfg, to, text: body, done: true });
    return { channel: "nova", ...result };
  },
};
