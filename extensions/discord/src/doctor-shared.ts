import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";

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
    typeof entry.streaming === "string" ||
    entry.chunkMode !== undefined ||
    entry.blockStreaming !== undefined ||
    entry.draftChunk !== undefined ||
    entry.blockStreamingCoalesce !== undefined
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
      "channels.discord.streamMode, channels.discord.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: hasLegacyDiscordStreamingAliases,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: hasLegacyDiscordAccountStreamingAliases,
  },
];
