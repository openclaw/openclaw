import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, DiscordApiError, fetchDiscord } from "./api.js";
import { isDiscordThreadChannelType } from "./channel-type.js";
import { listGuilds } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import {
  filterDiscordGuilds,
  parseDiscordAllowlistInput,
  resolveDiscordAllowlistToken,
} from "./resolve-allowlist-common.js";

type DiscordChannelSummary = {
  id: string;
  name: string;
  guildId: string;
  type?: number;
  archived?: boolean;
};

type DiscordChannelPayload = {
  id?: string;
  name?: string;
  type?: number;
  guild_id?: string;
  thread_metadata?: { archived?: boolean };
};

export type DiscordChannelResolution = {
  input: string;
  resolved: boolean;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  archived?: boolean;
  note?: string;
};

async function listGuildChannels(
  token: string,
  fetcher: typeof fetch,
  guildId: string,
): Promise<DiscordChannelSummary[]> {
  const raw = await fetchDiscord<DiscordChannelPayload[]>(
    `/guilds/${guildId}/channels`,
    token,
    fetcher,
    { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS },
  );
  return raw
    .map((channel) => {
      const archived = channel.thread_metadata?.archived;
      return {
        id: typeof channel.id === "string" ? channel.id : "",
        name: typeof channel.name === "string" ? channel.name : "",
        guildId,
        type: channel.type,
        archived,
      };
    })
    .filter((channel) => Boolean(channel.id) && Boolean(channel.name));
}

type FetchChannelResult =
  | { status: "found"; channel: DiscordChannelSummary }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "invalid" };

async function fetchChannel(
  token: string,
  fetcher: typeof fetch,
  channelId: string,
): Promise<FetchChannelResult> {
  let raw: DiscordChannelPayload;
  try {
    raw = await fetchDiscord<DiscordChannelPayload>(`/channels/${channelId}`, token, fetcher, {
      timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof DiscordApiError && err.status === 403) {
      return { status: "forbidden" };
    }
    if (err instanceof DiscordApiError && err.status === 404) {
      return { status: "not-found" };
    }
    throw err;
  }
  if (!raw || typeof raw.guild_id !== "string" || typeof raw.id !== "string") {
    return { status: "invalid" };
  }
  return {
    status: "found",
    channel: {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      guildId: raw.guild_id,
      type: raw.type,
    },
  };
}

function preferActiveMatch(candidates: DiscordChannelSummary[]): DiscordChannelSummary | undefined {
  const scored = candidates.map((channel) => {
    const isThread = isDiscordThreadChannelType(channel.type);
    const archived = Boolean(channel.archived);
    const score = (archived ? 0 : 2) + (isThread ? 0 : 1);
    return { channel, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.channel ?? candidates[0];
}

function resolvedChannelResult(
  input: string,
  channel: DiscordChannelSummary,
  guildName: string | undefined,
): DiscordChannelResolution {
  return {
    input,
    resolved: true,
    guildId: channel.guildId,
    guildName,
    channelId: channel.id,
    channelName: channel.name,
    archived: channel.archived,
  };
}

export async function resolveDiscordChannelAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordChannelResolution[]> {
  const token = resolveDiscordAllowlistToken(params.token);
  if (!token) {
    return params.entries.map((input) => ({
      input,
      resolved: false,
    }));
  }
  const fetcher = params.fetcher ?? fetch;
  const guilds = await listGuilds(token, fetcher, {
    timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
  });
  const channelsByGuild = new Map<string, Promise<DiscordChannelSummary[]>>();
  const getChannels = (guildId: string) => {
    const existing = channelsByGuild.get(guildId);
    if (existing) {
      return existing;
    }
    const promise = listGuildChannels(token, fetcher, guildId);
    channelsByGuild.set(guildId, promise);
    return promise;
  };

  async function matchingChannels(guildId: string, query: string, matchId = false) {
    const channels = await getChannels(guildId);
    if (matchId && /^\d+$/.test(query)) {
      const ids = channels.filter((channel) => channel.id === query);
      if (ids.length) {
        return ids;
      }
    }
    const slug = normalizeDiscordSlug(query);
    return channels.filter((channel) => normalizeDiscordSlug(channel.name) === slug);
  }

  const resolveEntry = async (input: string): Promise<DiscordChannelResolution> => {
    const parsed = parseDiscordAllowlistInput(input, "channel");
    const unresolved = { input, resolved: false };
    if (parsed.guildOnly) {
      const guild = filterDiscordGuilds(guilds, {
        guildId: parsed.guildId,
        guildName: parsed.guild,
      })[0];
      return {
        input,
        resolved: Boolean(guild),
        guildId: guild ? guild.id : parsed.guildId,
        guildName: guild ? guild.name : parsed.guild,
      };
    }

    if (parsed.id) {
      const channelId = parsed.id;
      const result = await fetchChannel(token, fetcher, channelId);
      if (result.status === "found") {
        const channel = result.channel;
        const guild = guilds.find((entry) => entry.id === channel.guildId);
        if (parsed.guildId && parsed.guildId !== channel.guildId) {
          return {
            ...unresolved,
            guildId: parsed.guildId,
            guildName: guilds.find((entry) => entry.id === parsed.guildId)?.name,
            channelId,
            channelName: channel.name,
            note: guild?.name
              ? `channel belongs to guild ${guild.name}`
              : "channel belongs to a different guild",
          };
        }
        return resolvedChannelResult(input, channel, guild?.name);
      }

      if (result.status === "not-found" && parsed.guildId) {
        const guild = guilds.find((entry) => entry.id === parsed.guildId);
        const match = guild && preferActiveMatch(await matchingChannels(guild.id, channelId));
        if (match) {
          return resolvedChannelResult(input, match, guild?.name);
        }
      }
      return { ...unresolved, guildId: parsed.guildId, channelId };
    }

    const guildScoped = Boolean(parsed.guildId || parsed.guild);
    const guild = guildScoped
      ? filterDiscordGuilds(guilds, { guildId: parsed.guildId, guildName: parsed.guild })[0]
      : undefined;
    const channelName = guildScoped ? parsed.name?.trim() : input.trim().replace(/^#/, "");
    if (guildScoped && (!guild || !channelName)) {
      return {
        ...unresolved,
        guildId: parsed.guildId,
        guildName: parsed.guild,
        channelName: channelName ?? parsed.name,
      };
    }
    if (!channelName) {
      return { ...unresolved, channelName };
    }

    let candidates: DiscordChannelSummary[] = [];
    for (const candidateGuild of guild ? [guild] : guilds) {
      candidates = candidates.concat(
        await matchingChannels(candidateGuild.id, channelName, guildScoped),
      );
    }
    const match = preferActiveMatch(candidates);
    if (match) {
      const matchedGuild = guild ?? guilds.find((entry) => entry.id === match.guildId);
      return {
        ...resolvedChannelResult(input, match, matchedGuild?.name),
        ...(!guildScoped
          ? {
              note:
                candidates.length > 1 && matchedGuild?.name
                  ? `matched multiple; chose ${matchedGuild.name}`
                  : undefined,
            }
          : {}),
      };
    }
    return guild
      ? {
          ...unresolved,
          guildId: guild.id,
          guildName: guild.name,
          channelName: parsed.name,
          note: `channel not found in guild ${guild.name}`,
        }
      : { ...unresolved, channelName };
  };

  const results: DiscordChannelResolution[] = [];
  for (const input of params.entries) {
    results.push(await resolveEntry(input));
  }
  return results;
}
