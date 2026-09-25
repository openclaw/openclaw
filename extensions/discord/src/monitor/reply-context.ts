import type { Guild, Message, User } from "../internal/discord.js";
import { resolveTimestampMs } from "./format.js";
import {
  resolveDiscordReferencedReplyMessage,
  resolveDiscordReferencedReplyMessageId,
} from "./message-forwarded.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

type DiscordReplyContext = {
  id: string;
  channelId: string;
  sender: string;
  senderId?: string;
  senderName?: string;
  senderTag?: string;
  memberRoleIds?: string[];
  body?: string;
  timestamp?: number;
};

export function resolveReplyContext(
  message: Message,
  resolveDiscordMessageText: (message: Message, options?: { includeForwarded?: boolean }) => string,
): DiscordReplyContext | null {
  const id = resolveDiscordReferencedReplyMessageId(message);
  if (!id) {
    return null;
  }
  const referenced = resolveDiscordReferencedReplyMessage(message);
  const channelId = message.messageReference?.channel_id ?? message.channelId;
  if (!referenced?.author || referenced.id !== id) {
    return null;
  }
  const referencedText = resolveDiscordMessageText(referenced, {
    includeForwarded: true,
  });
  const sender = resolveDiscordSenderIdentity({
    author: referenced.author,
    pluralkitInfo: null,
  });
  return {
    id,
    channelId,
    sender: sender.tag ?? sender.label ?? "unknown",
    senderId: referenced.author.id,
    senderName: referenced.author.username ?? undefined,
    senderTag: sender.tag ?? undefined,
    memberRoleIds: (() => {
      const roles = (referenced as { member?: { roles?: string[] } }).member?.roles;
      return Array.isArray(roles) ? roles.map((roleId) => roleId) : undefined;
    })(),
    ...(referencedText ? { body: referencedText } : {}),
    timestamp: resolveTimestampMs(referenced.timestamp),
  };
}

export function buildDirectLabel(author: User, tagOverride?: string) {
  const username =
    tagOverride?.trim() || resolveDiscordSenderIdentity({ author, pluralkitInfo: null }).tag;
  return `${username ?? "unknown"} user id:${author.id}`;
}

export function buildGuildLabel(params: {
  guild?: Guild<true> | Guild;
  channelName: string;
  channelId: string;
}) {
  const { guild, channelName, channelId } = params;
  return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}
