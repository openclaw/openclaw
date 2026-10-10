import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, fetchDiscord } from "./api.js";
import { listGuilds, type DiscordGuildSummary } from "./guilds.js";
import {
  filterDiscordGuilds,
  parseDiscordAllowlistInput,
  resolveDiscordAllowlistToken,
} from "./resolve-allowlist-common.js";

type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string;
  bot?: boolean;
};

type DiscordMember = {
  user: DiscordUser;
  nick?: string | null;
};

export type DiscordUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  guildId?: string;
  guildName?: string;
  note?: string;
};

function scoreDiscordMember(member: DiscordMember, query: string): number {
  const q = query.toLowerCase();
  const user = member.user;
  const candidates = [user.username, user.global_name, member.nick]
    .map(normalizeOptionalLowercaseString)
    .filter((value) => value !== undefined);
  const exactMatchScore = candidates.includes(q) ? 3 : 0;
  const partialMatchScore = candidates.some((value) => value.includes(q)) ? 1 : 0;
  return exactMatchScore + partialMatchScore + (user.bot ? 0 : 1);
}

export async function resolveDiscordUserAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordUserResolution[]> {
  const token = resolveDiscordAllowlistToken(params.token);
  if (!token) {
    return params.entries.map((input) => ({
      input,
      resolved: false,
    }));
  }
  const fetcher = params.fetcher ?? fetch;

  // Lazy-load guilds: only fetch when an entry actually needs username search.
  // This prevents listGuilds() failures (permissions, network) from blocking
  // resolution of plain user-id entries that don't need guild data at all.
  let guilds: Promise<DiscordGuildSummary[]> | undefined;
  const getGuilds = () =>
    (guilds ??= listGuilds(token, fetcher, {
      timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
    }));

  const results: DiscordUserResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseDiscordAllowlistInput(input, "user");
    if (parsed.id) {
      results.push({
        input,
        resolved: true,
        id: parsed.id,
      });
      continue;
    }

    const query = parsed.name?.trim();
    if (!query) {
      results.push({ input, resolved: false });
      continue;
    }

    const allGuilds = await getGuilds();
    const guildList = filterDiscordGuilds(allGuilds, {
      guildId: parsed.guildId,
      guildName: parsed.guild,
    });

    let best: { member: DiscordMember; guild: DiscordGuildSummary; score: number } | null = null;
    let matches = 0;

    for (const guild of guildList) {
      const paramsObj = new URLSearchParams({
        query,
        limit: "25",
      });
      const members = await fetchDiscord<DiscordMember[]>(
        `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
        token,
        fetcher,
        { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS },
      );
      for (const member of members) {
        const score = scoreDiscordMember(member, query);
        if (score === 0) {
          continue;
        }
        matches += 1;
        if (!best || score > best.score) {
          best = { member, guild, score };
        }
      }
    }

    if (best) {
      const user = best.member.user;
      const name =
        normalizeOptionalString(best.member.nick) ??
        normalizeOptionalString(user.global_name) ??
        normalizeOptionalString(user.username);
      results.push({
        input,
        resolved: true,
        id: user.id,
        name,
        guildId: best.guild.id,
        guildName: best.guild.name,
        note: matches > 1 ? "multiple matches; chose best" : undefined,
      });
    } else {
      results.push({ input, resolved: false });
    }
  }

  return results;
}
