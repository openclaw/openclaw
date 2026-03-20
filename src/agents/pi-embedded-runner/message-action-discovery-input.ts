import type { OpenClawConfig } from "../../config/config.js";

export function buildEmbeddedMessageActionDiscoveryInput(params: {
  cfg?: OpenClawConfig;
  channel: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  senderId?: string | null;
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    accountId: params.accountId ?? undefined,
    sessionKey: params.sessionKey ?? undefined,
    sessionId: params.sessionId ?? undefined,
    agentId: params.agentId ?? undefined,
    requesterSenderId: params.senderId ?? undefined,
  };
}
