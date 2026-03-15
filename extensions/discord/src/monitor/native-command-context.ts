import type { CommandArgs } from "../../../../src/auto-reply/commands-registry.js";
import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import { type DiscordChannelConfigResolved, type DiscordGuildEntryResolved } from "./allow-list.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";

export type BuildDiscordNativeCommandContextParams = {
  prompt: string;
  commandArgs: CommandArgs;
  sessionKey: string;
  commandTargetSessionKey: string;
  accountId?: string | null;
  interactionId: string;
  channelId: string;
  threadParentId?: string;
  guildName?: string;
  channelTopic?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuild: boolean;
  isThreadChannel: boolean;
  user: {
    id: string;
    username: string;
    globalName?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  timestampMs?: number;
};

export function buildDiscordNativeCommandContext(params: BuildDiscordNativeCommandContextParams) {
  const conversationLabel = params.isDirectMessage
    ? (params.user.globalName ?? params.user.username)
    : params.channelId;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
    isGuild: params.isGuild,
    channelTopic: params.channelTopic,
  });

  // Discord thread ID is the root message ID (first message in the thread).
  // This is used by other systems (e.g., Feishu) for thread reconstruction.
  const rootMessageId = params.isThreadChannel ? params.channelId : undefined;

  return finalizeInboundContext({
    Body: params.prompt,
    BodyForAgent: params.prompt,
    RawBody: params.prompt,
    CommandBody: params.prompt,
    CommandArgs: params.commandArgs,
    From: params.isDirectMessage
      ? `discord:${params.user.id}`
      : params.isGroupDm
        ? `discord:group:${params.channelId}`
        : `discord:channel:${params.channelId}`,
    To: `slash:${params.user.id}`,
    SessionKey: params.sessionKey,
    CommandTargetSessionKey: params.commandTargetSessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
    GroupSubject: params.isGuild ? params.guildName : undefined,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedContext,
    OwnerAllowFrom: ownerAllowFrom,
    SenderName: params.user.globalName ?? params.user.username,
    SenderId: params.user.id,
    SenderUsername: params.user.username,
    SenderTag: params.sender.tag,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    MessageSid: params.interactionId,
    RootMessageId: rootMessageId,
    MessageThreadId: rootMessageId,
    ThreadParentId: params.isThreadChannel ? params.threadParentId : undefined,
    Timestamp: params.timestampMs ?? Date.now(),
    CommandAuthorized: params.commandAuthorized,
    CommandSource: "native" as const,
    // Native slash contexts use To=slash:<user> for interaction routing.
    // For follow-up delivery (for example subagent completion announces),
    // preserve the real Discord target separately.
    OriginatingChannel: "discord" as const,
    OriginatingTo: params.isDirectMessage
      ? `user:${params.user.id}`
      : `channel:${params.channelId}`,
  });
}
