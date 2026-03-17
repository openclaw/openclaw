import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";
function buildDiscordNativeCommandContext(params) {
  const conversationLabel = params.isDirectMessage ? params.user.globalName ?? params.user.username : params.channelId;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
    isGuild: params.isGuild,
    channelTopic: params.channelTopic
  });
  return finalizeInboundContext({
    Body: params.prompt,
    BodyForAgent: params.prompt,
    RawBody: params.prompt,
    CommandBody: params.prompt,
    CommandArgs: params.commandArgs,
    From: params.isDirectMessage ? `discord:${params.user.id}` : params.isGroupDm ? `discord:group:${params.channelId}` : `discord:channel:${params.channelId}`,
    To: `slash:${params.user.id}`,
    SessionKey: params.sessionKey,
    CommandTargetSessionKey: params.commandTargetSessionKey,
    AccountId: params.accountId ?? void 0,
    ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
    GroupSubject: params.isGuild ? params.guildName : void 0,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedContext,
    OwnerAllowFrom: ownerAllowFrom,
    SenderName: params.user.globalName ?? params.user.username,
    SenderId: params.user.id,
    SenderUsername: params.user.username,
    SenderTag: params.sender.tag,
    Provider: "discord",
    Surface: "discord",
    WasMentioned: true,
    MessageSid: params.interactionId,
    MessageThreadId: params.isThreadChannel ? params.channelId : void 0,
    Timestamp: params.timestampMs ?? Date.now(),
    CommandAuthorized: params.commandAuthorized,
    CommandSource: "native",
    // Native slash contexts use To=slash:<user> for interaction routing.
    // For follow-up delivery (for example subagent completion announces),
    // preserve the real Discord target separately.
    OriginatingChannel: "discord",
    OriginatingTo: params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`,
    ThreadParentId: params.isThreadChannel ? params.threadParentId : void 0
  });
}
export {
  buildDiscordNativeCommandContext
};
