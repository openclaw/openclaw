import type { DiscordGuildSummary } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

export function resolveDiscordAllowlistToken(token: string): string | undefined {
  return normalizeDiscordToken(token, "channels.discord.token");
}

export function filterDiscordGuilds(
  guilds: DiscordGuildSummary[],
  params: { guildId?: string; guildName?: string },
): DiscordGuildSummary[] {
  if (params.guildId) {
    return guilds.filter((guild) => guild.id === params.guildId);
  }
  if (params.guildName) {
    const slug = normalizeDiscordSlug(params.guildName);
    const match = slug ? guilds.find((guild) => guild.slug === slug) : undefined;
    return match ? [match] : [];
  }
  return guilds;
}
