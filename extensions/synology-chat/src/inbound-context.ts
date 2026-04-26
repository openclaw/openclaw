import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

export type SynologyInboundMessage = {
  body: string;
  from: string;
  senderName: string;
  provider: string;
  chatType: string;
  accountId: string;
  commandAuthorized: boolean;
  chatUserId?: string;
  channelId?: string;
  channelName?: string;
};

export function buildSynologyChatInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  const isGroup = msg.chatType === "group";
  const groupTarget = msg.channelId ?? msg.channelName;

  return params.finalizeInboundContext({
    Body: msg.body,
    RawBody: msg.body,
    CommandBody: msg.body,
    From: isGroup ? `synology-chat:group:${groupTarget}` : `synology-chat:${msg.from}`,
    To: isGroup ? `synology-chat:channel:${groupTarget}` : `synology-chat:${msg.from}`,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: isGroup ? `synology-chat:channel:${groupTarget}` : `synology-chat:${msg.from}`,
    ChatType: msg.chatType,
    SenderName: msg.senderName,
    SenderId: msg.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: isGroup
      ? (msg.channelName ?? msg.channelId ?? "channel")
      : msg.senderName || msg.from,
    Timestamp: Date.now(),
    CommandAuthorized: msg.commandAuthorized,
  });
}
