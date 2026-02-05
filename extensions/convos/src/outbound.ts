import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { resolveConvosAccount, type CoreConfig } from "./accounts.js";
import type { ConvosSDKClient } from "./sdk-client.js";
import { getConvosRuntime } from "./runtime.js";

// Track SDK clients by account ID (set by channel.ts during startAccount)
const clients = new Map<string, ConvosSDKClient>();

/**
 * Set the SDK client for an account (called from channel.ts)
 */
export function setClientForAccount(accountId: string, client: ConvosSDKClient | null): void {
  if (client) {
    clients.set(accountId, client);
  } else {
    clients.delete(accountId);
  }
}

/**
 * Get the SDK client for an account
 */
export function getClientForAccount(accountId: string): ConvosSDKClient | undefined {
  return clients.get(accountId);
}

export const convosOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getConvosRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ cfg, to, text, accountId }) => {
    const account = resolveConvosAccount({
      cfg: cfg as CoreConfig,
      accountId,
    });
    const client = clients.get(account.accountId);
    if (!client) {
      throw new Error(
        `Convos client not running for account ${account.accountId}. Is the gateway started?`,
      );
    }
    const result = await client.sendMessage(to, text);
    return {
      channel: "convos",
      messageId: result.messageId ?? `convos-${Date.now()}`,
    };
  },

  sendMedia: async () => {
    throw new Error("Media sending not yet implemented in Convos");
  },
};
