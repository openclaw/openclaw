import { resolveInboundSupplementalSenderAllowed } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveDiscordGroupToolPolicy } from "../group-policy.js";
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
  cfg: OpenClawConfig;
  accountId: string;
  parentId?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  allowNameMatching?: boolean;
  senderName?: string;
  senderUsername?: string;
  isGuild: boolean;
  channelTopic?: string;
}) {
  return {
    // Use the admitted parent identity, never the thread's user-controlled title.
    toolPolicy:
      params.isGuild && params.channelConfig?.matchSource === "parent"
        ? resolveDiscordGroupToolPolicy({
            cfg: params.cfg,
            accountId: params.accountId,
            groupId: params.parentId,
            groupChannel: params.channelConfig?.matchKey,
            groupSpace: params.guildInfo?.id ?? params.guildInfo?.slug,
            senderId: params.sender.id,
            senderName: params.senderName ?? params.sender.name,
            senderUsername: params.senderUsername ?? params.sender.name,
          })
        : undefined,
    groupSystemPrompt: params.isGuild
      ? buildDiscordGroupSystemPrompt(params.channelConfig)
      : undefined,
    channelStructuredContext: buildDiscordChannelStructuredContext(params),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom(params),
  };
}
