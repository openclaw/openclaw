import type { DiscordGuildSummary } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";

function findDiscordGuildByName(
  guilds: DiscordGuildSummary[],
  input: string,
): DiscordGuildSummary | undefined {
  const slug = normalizeDiscordSlug(input);
  if (!slug) {
    return undefined;
  }
  return guilds.find((guild) => guild.slug === slug);
}

export function filterDiscordGuilds(
  guilds: DiscordGuildSummary[],
  params: { guildId?: string; guildName?: string },
): DiscordGuildSummary[] {
  if (params.guildId) {
    return guilds.filter((guild) => guild.id === params.guildId);
  }
  if (params.guildName) {
    const match = findDiscordGuildByName(guilds, params.guildName);
    return match ? [match] : [];
  }
  return guilds;
}
