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

export async function listGuilds(
  token: string,
  fetcher: typeof fetch,
  options?: { timeoutMs?: number; allPages?: boolean },
): Promise<DiscordGuildSummary[]> {
  const guilds: DiscordGuildSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchDiscord<Array<{ id?: string; name?: string }>>(
      after ? `/users/@me/guilds?after=${encodeURIComponent(after)}` : "/users/@me/guilds",
      token,
      fetcher,
      options,
    );
    for (const guild of page) {
      if (typeof guild.id === "string" && typeof guild.name === "string") {
        guilds.push({ id: guild.id, name: guild.name, slug: normalizeDiscordSlug(guild.name) });
      }
    }
    if (!options?.allPages || page.length < 200) {
      return guilds;
    }
    const cursor = page.at(-1)?.id;
    if (!cursor || cursor === after) {
      throw new Error("Discord returned an incomplete server directory.");
    }
    after = cursor;
  }
}
