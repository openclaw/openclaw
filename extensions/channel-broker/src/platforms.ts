import { normalizeBrokerKnownPlatformId } from "openclaw/plugin-sdk/channel-broker";

export const CHANNEL_BROKER_PLATFORM_TARGET_PREFIXES = [
  "broker",
  "channel-broker",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "matrix",
  "microsoft-teams",
  "msteams",
  "teams",
  "googlechat",
  "google-chat",
  "line",
  "wechat",
  "weixin",
  "openclaw-weixin",
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
  return normalizeBrokerKnownPlatformId(value);
}
