import { fetchDiscord } from "./api.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";

export type DiscordGuildSummary = {
  id: string;
  name: string;
  slug: string;
};

export async function listGuilds(
  token: string,
  fetcher: typeof fetch,
  options?: { timeoutMs?: number },
): Promise<DiscordGuildSummary[]> {
  const raw = await fetchDiscord<Array<{ id?: string; name?: string }>>(
    "/users/@me/guilds",
    token,
    fetcher,
    options,
  );
  return raw.flatMap((guild) =>
    typeof guild.id === "string" && typeof guild.name === "string"
      ? [{ id: guild.id, name: guild.name, slug: normalizeDiscordSlug(guild.name) }]
      : [],
  );
}
