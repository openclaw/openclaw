import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, fetchDiscord } from "./api.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";

export type DiscordGuildSummary = {
  id: string;
  name: string;
  slug: string;
};

export type DiscordGuildMember = {
  user: { id: string; username: string; global_name?: string; bot?: boolean };
  nick?: string | null;
};

export type DiscordGuildChannel = {
  id?: string;
  name?: string | null;
  type?: number;
  guild_id?: string;
  parent_id?: string | null;
  thread_metadata?: { archived?: boolean };
};

export function listDiscordGuildChannels(token: string, fetcher: typeof fetch, guildId: string) {
  return fetchDiscord<DiscordGuildChannel[]>(`/guilds/${guildId}/channels`, token, fetcher, {
    timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
  });
}

export function searchDiscordGuildMembers(
  token: string,
  fetcher: typeof fetch,
  guildId: string,
  query: string,
  limit: number,
) {
  const params = new URLSearchParams({ query, limit: String(limit) });
  return fetchDiscord<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?${params.toString()}`,
    token,
    fetcher,
    { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS },
  );
}

export type DiscordGuild = { id: string; name: string };

export function fetchDiscordGuildsPage(
  token: string,
  fetcher: typeof fetch,
  options?: { timeoutMs?: number },
) {
  return fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token, fetcher, options);
}

export async function listGuilds(
  token: string,
  fetcher: typeof fetch,
  options?: { timeoutMs?: number },
): Promise<DiscordGuildSummary[]> {
  const raw = await fetchDiscordGuildsPage(token, fetcher, options);
  return raw.flatMap((guild) =>
    typeof guild.id === "string" && typeof guild.name === "string"
      ? [{ id: guild.id, name: guild.name, slug: normalizeDiscordSlug(guild.name) }]
      : [],
  );
}
