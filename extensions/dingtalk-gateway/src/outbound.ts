import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";

import { getDingTalkGatewayRuntime } from "./runtime.js";
import { sendMessageDingTalkGateway } from "./send.js";

export const dingtalkGatewayOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) =>
    getDingTalkGatewayRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, deps }) => {
    // Note: kafkaClient and outboundTopic should be provided via deps or context
    // For now, this is a placeholder - actual implementation should get kafkaClient from context
    throw new Error(
      "DingTalk Gateway outbound requires kafkaClient context. Use monitor for message processing.",
    );
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, deps }) => {
    throw new Error(
      "DingTalk Gateway outbound requires kafkaClient context. Use monitor for message processing.",
    );
  },
};
