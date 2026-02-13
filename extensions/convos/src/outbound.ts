import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { ConvosInstance } from "./sdk-client.js";
import { getConvosRuntime } from "./runtime.js";

// Single instance — this process has one conversation
let instance: ConvosInstance | null = null;

export function setConvosInstance(inst: ConvosInstance | null): void {
  instance = inst;
}

export function getConvosInstance(): ConvosInstance | null {
  return instance;
}

export const convosOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getConvosRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ to, text }) => {
    if (!instance) {
      throw new Error("Convos instance not running. Is the gateway started?");
    }
    // In 1:1, `to` should match the instance's conversation.
    // Assert to catch misrouting bugs.
    if (to && to !== instance.conversationId) {
      throw new Error(`Convos routing mismatch: expected ${instance.conversationId}, got ${to}`);
    }
    const result = await instance.sendMessage(text);
    return {
      channel: "convos",
      messageId: result.messageId ?? `convos-${Date.now()}`,
    };
  },

  sendMedia: async () => {
    throw new Error("Media sending not yet implemented in Convos");
  },
};
