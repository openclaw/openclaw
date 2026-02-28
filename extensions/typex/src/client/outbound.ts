import type { ChannelOutboundAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { getTypeXClient } from "./client.js";
import { sendMessageTypeX } from "./send.js";

function resolveToken(cfg: OpenClawConfig, accountId?: string | null): string | undefined {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
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
    const token = resolveToken(cfg, accountId);
    const client = getTypeXClient(accountId ?? undefined, { token, skipConfigCheck: true });
    const result = await sendMessageTypeX(client, { text });
    return {
      channel: "typex",
      messageId: result?.message_id || "unknown",
      chatId: to,
    };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }: any) => {
    const token = resolveToken(cfg, accountId);
    const client = getTypeXClient(accountId ?? undefined, { token, skipConfigCheck: true });
    const result = await sendMessageTypeX(client, { text: text || "" }, { mediaUrl });
    return {
      channel: "typex",
      messageId: result?.message_id || "unknown",
      chatId: to,
    };
  },
};
