import {
  buildUntrustedChannelMetadata,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
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
  messageBody?: string;
}): string[] | undefined {
  if (!params.isGuild) {
    return undefined;
  }
  const entries = [
    buildUntrustedChannelMetadata({
      source: "discord",
      label: "Discord channel topic",
      entries: [params.channelTopic],
    }),
    typeof params.messageBody === "string" && params.messageBody.trim().length > 0
      ? wrapExternalContent(`UNTRUSTED Discord message body\n${params.messageBody.trim()}`, {
          source: "unknown",
          includeWarning: false,
        })
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
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
  messageBody?: string;
}) {
  return {
    groupSystemPrompt: params.isGuild
      ? buildDiscordGroupSystemPrompt(params.channelConfig)
      : undefined,
    untrustedContext: buildDiscordUntrustedContext({
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
      messageBody: params.messageBody,
    }),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching,
    }),
  };
}
