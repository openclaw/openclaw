import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { buildDiscordGroupSystemPrompt } from "../monitor/inbound-context.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import type { VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

export const DISCORD_VOICE_MESSAGE_PROVIDER = "discord-voice";

export type DiscordVoiceIngressContext = {
  extraSystemPrompt: string | undefined;
  senderIsOwner: boolean;
  speakerLabel: string;
};

export async function resolveDiscordVoiceIngressContext(params: {
  entry: VoiceSessionEntry;
  userId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceIngressContext | null> {
  const { entry, userId } = params;
  if (!entry.guildName) {
    entry.guildName = await params.fetchGuildName(entry.guildId);
  }
  const speaker = await params.speakerContext.resolveContext(entry.guildId, userId);
  const speakerIdentity = await params.speakerContext.resolveIdentity(entry.guildId, userId);
  const access = await authorizeDiscordVoiceIngress({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    guildName: entry.guildName,
    guildId: entry.guildId,
    channelId: entry.channelId,
    channelName: entry.channelName,
    channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
    channelLabel: formatMention({ channelId: entry.channelId }),
    memberRoleIds: speakerIdentity.memberRoleIds,
    ownerAllowFrom: params.ownerAllowFrom,
    sender: {
      id: speakerIdentity.id,
      name: speakerIdentity.name,
      tag: speakerIdentity.tag,
    },
  });
  if (!access.ok) {
    return null;
  }
  return {
    extraSystemPrompt: buildDiscordGroupSystemPrompt(access.channelConfig),
    senderIsOwner: speaker.senderIsOwner,
    speakerLabel: speaker.label,
  };
}
