import { resolveInboundSupplementalSenderAllowed } from "openclaw/plugin-sdk/channel-inbound";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

type DiscordSupplementalContextSender = {
  id?: string;
  name?: string;
  tag?: string;
  memberRoleIds?: readonly string[];
};

export function createDiscordSupplementalContextAccessChecker(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  isGuild: boolean;
}) {
  const userAllowList = params.channelConfig?.users ?? params.guildInfo?.users ?? [];
  const roleAllowList = params.channelConfig?.roles ?? params.guildInfo?.roles ?? [];
  const allowFrom = [...userAllowList, ...roleAllowList];
  return (sender: DiscordSupplementalContextSender): boolean =>
    resolveInboundSupplementalSenderAllowed({
      isGroup: params.isGuild,
      groupPolicy: allowFrom.length === 0 ? "open" : "allowlist",
      allowFrom,
      isSenderAllowed: () =>
        resolveDiscordMemberAllowed({
          userAllowList,
          roleAllowList,
          memberRoleIds: [...(sender.memberRoleIds ?? [])],
          userId: sender.id ?? "",
          userName: sender.name,
          userTag: sender.tag,
          allowNameMatching: params.allowNameMatching,
        }),
    });
}

export function buildDiscordGroupSystemPrompt(
  channelConfig?: DiscordChannelConfigResolved | null,
): string | undefined {
  return channelConfig?.systemPrompt?.trim() || undefined;
}

function buildDiscordChannelStructuredContext(params: {
  isGuild: boolean;
  channelTopic?: string;
}): MsgContext["ChannelStructuredContext"] | undefined {
  if (!params.isGuild || typeof params.channelTopic !== "string" || !params.channelTopic.trim()) {
    return undefined;
  }
  return [
    {
      label: "Discord channel metadata",
      source: "discord",
      type: "channel_metadata",
      payload: { topic: params.channelTopic.trim() },
    },
  ];
}

export function buildDiscordInboundAccessContext(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  allowNameMatching?: boolean;
  isGuild: boolean;
  channelTopic?: string;
}) {
  return {
    groupSystemPrompt: params.isGuild
      ? buildDiscordGroupSystemPrompt(params.channelConfig)
      : undefined,
    channelStructuredContext: buildDiscordChannelStructuredContext(params),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom(params),
  };
}
