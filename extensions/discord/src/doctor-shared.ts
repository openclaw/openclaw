import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyDiscordStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    (typeof entry.streaming === "string" &&
      entry.streaming !== resolveDiscordPreviewStreamMode(entry))
  );
}

function hasLegacyDiscordAccountStreamingAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyDiscordStreamingAliases(account));
}

export const DISCORD_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "discord"],
    message:
      "channels.discord.streamMode and boolean channels.discord.streaming are legacy; use channels.discord.streaming.",
    match: hasLegacyDiscordStreamingAliases,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode and boolean channels.discord.accounts.<id>.streaming are legacy; use channels.discord.accounts.<id>.streaming.",
    match: hasLegacyDiscordAccountStreamingAliases,
  },
];
