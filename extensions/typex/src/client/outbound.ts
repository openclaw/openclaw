import type { ChannelOutboundAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { getTypeXClient } from "./client.js";
import { sendMessageTypeX } from "./send.js";

function resolveOutboundAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  const explicit = accountId?.trim();
  if (explicit) {
    return explicit;
  }
  const configuredDefault = cfg.channels?.typex?.defaultAccount?.trim();
  if (configuredDefault) {
    return configuredDefault;
  }
  return DEFAULT_ACCOUNT_ID;
}

function resolveToken(cfg: OpenClawConfig, accountId?: string | null): string | undefined {
  const id = resolveOutboundAccountId(cfg, accountId);
  const account = cfg.channels?.typex?.accounts?.[id];
  if (typeof account?.token === "string" && account.token.trim()) {
    return account.token;
  }
  const rootToken = cfg.channels?.typex?.token;
  if (typeof rootToken === "string" && rootToken.trim()) {
    return rootToken;
  }
  return undefined;
}

export const typexOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "markdown",
  textChunkLimit: 2000,

  sendText: async ({ to, text, accountId, cfg }: any) => {
    const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
    const token = resolveToken(cfg, accountId);
    const client = getTypeXClient(resolvedAccountId, { token, skipConfigCheck: true });
    const result = await sendMessageTypeX(client, to, text ?? "");
    return {
      channel: "typex",
      messageId: result?.message_id || "unknown",
      chatId: to,
    };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }: any) => {
    if (mediaUrl) {
      throw new Error("TypeX media sending is not supported yet.");
    }
    const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
    const token = resolveToken(cfg, accountId);
    const client = getTypeXClient(resolvedAccountId, { token, skipConfigCheck: true });
    const result = await sendMessageTypeX(client, to, text ?? "");
    return {
      channel: "typex",
      messageId: result?.message_id || "unknown",
      chatId: to,
    };
  },
};
