import { normalizeBrokerPlatformId } from "openclaw/plugin-sdk/channel-broker";

export const CHANNEL_BROKER_PLATFORM_ALIASES: Record<string, string> = {
  googlechat: "google-chat",
  msteams: "microsoft-teams",
  teams: "microsoft-teams",
  qq: "qqbot",
};

export const CHANNEL_BROKER_PLATFORM_TARGET_PREFIXES = [
  "broker",
  "channel-broker",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "imessage",
  "matrix",
  "microsoft-teams",
  "msteams",
  "teams",
  "googlechat",
  "google-chat",
  "line",
  "wechat",
  "qq",
  "qqbot",
  "feishu",
  "zalo",
  "irc",
  "mattermost",
  "nextcloud-talk",
  "nostr",
  "tlon",
  "synology-chat",
  "twitch",
] as const;

export function normalizeKnownChannelBrokerPlatformId(value: string): string {
  const normalized = normalizeBrokerPlatformId(value);
  return CHANNEL_BROKER_PLATFORM_ALIASES[normalized] ?? normalized;
}
