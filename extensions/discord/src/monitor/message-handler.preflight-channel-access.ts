import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  hasConfiguredDiscordChannels,
  isDiscordGroupAllowedByPolicy,
  resolveGroupDmAllow,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

export function resolveDiscordPreflightChannelAccess(params: {
  isGuildMessage: boolean;
  isGroupDm: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
  groupDmChannels?: string[];
  messageChannelId: string;
  displayChannelName?: string;
  displayChannelSlug: string;
  guildInfo: DiscordGuildEntryResolved | null;
  channelConfig: DiscordChannelConfigResolved | null;
  channelMatchMeta: string;
}): boolean {
  if (params.isGuildMessage && params.channelConfig?.enabled === false) {
    logVerbose(
      `Blocked discord channel ${params.messageChannelId} (channel disabled, ${params.channelMatchMeta})`,
    );
    return false;
  }

  const groupDmAllowed =
    params.isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: params.messageChannelId,
      channelName: params.displayChannelName,
      channelSlug: params.displayChannelSlug,
    });
  if (params.isGroupDm && !groupDmAllowed) {
    return false;
  }

  const channelAllowlistConfigured = hasConfiguredDiscordChannels(params.guildInfo?.channels);
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (
    params.isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(params.guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${params.channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${params.channelMatchMeta})`,
      );
    } else {
      logVerbose(
        `Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${params.channelMatchMeta}). Add to guilds.<guildId>.channels to enable.`,
      );
    }
    return false;
  }

  if (params.isGuildMessage && params.channelConfig?.allowed === false) {
    logVerbose(
      `Blocked discord channel ${params.messageChannelId} not in guild channel allowlist (${params.channelMatchMeta})`,
    );
    return false;
  }
  return true;
}
