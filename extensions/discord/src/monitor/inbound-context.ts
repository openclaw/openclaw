import { buildUntrustedChannelMetadata } from "../../../../src/security/channel-metadata.js";
import {
  resolveDiscordOwnerAllowFrom,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

export function buildDiscordGroupSystemPrompt(
  channelConfig?: DiscordChannelConfigResolved | null,
): string | undefined {
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
}

export function buildDiscordUntrustedContext(params: {
  isGuild: boolean;
  channelTopic?: string;
}): string[] | undefined {
  if (!params.isGuild) {
    return undefined;
  }
  const untrustedChannelMetadata = buildUntrustedChannelMetadata({
    source: "discord",
    label: "Discord channel topic",
    entries: [params.channelTopic],
  });
  return untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined;
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
    untrustedContext: buildDiscordUntrustedContext({
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
    }),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching,
    }),
  };
}
