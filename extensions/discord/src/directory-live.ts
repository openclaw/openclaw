import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS } from "./api.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { listDiscordGuildChannels, listGuilds, searchDiscordGuildMembers } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

type DiscordDirectoryAccess = { token: string; query: string; accountId: string };

function resolveDiscordDirectoryAccess(
  params: DirectoryConfigParams,
): DiscordDirectoryAccess | null {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = normalizeDiscordToken(account.token, "channels.discord.token");
  if (!token) {
    return null;
  }
  return {
    token,
    query: normalizeOptionalLowercaseString(params.query) ?? "",
    accountId: account.accountId,
  };
}

async function listDiscordDirectoryLive(
  params: DirectoryConfigParams,
  kind: "group" | "user",
): Promise<ChannelDirectoryEntry[]> {
  const access = resolveDiscordDirectoryAccess(params);
  if (!access || (kind === "user" && !access.query)) {
    return [];
  }
  const { token, query, accountId } = access;
  const guilds = await listGuilds(token, fetch, { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS });
  const rows: ChannelDirectoryEntry[] = [];
  const seenUserIds = new Set<string>();
  const limit =
    kind === "user" && typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;
  for (const guild of guilds) {
    if (!guild.id || !guild.name) {
      continue;
    }
    if (kind === "group") {
      const channels = await listDiscordGuildChannels(token, fetch, guild.id);
      for (const channel of channels) {
        const name = channel.name?.trim();
        if (!name) {
          continue;
        }
        if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) {
          continue;
        }
        rows.push({
          kind: "group",
          id: `channel:${channel.id}`,
          name,
          handle: `#${name}`,
          raw: channel,
        });
        if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) {
          return rows;
        }
      }
    } else {
      const members = await searchDiscordGuildMembers(
        token,
        fetch,
        guild.id,
        query,
        Math.min(limit, 100),
      );
      for (const member of members) {
        const user = member.user;
        if (!user?.id) {
          continue;
        }
        rememberDiscordDirectoryUser({
          accountId,
          userId: user.id,
          handles: [
            user.username,
            user.global_name,
            member.nick,
            user.username ? `@${user.username}` : null,
          ],
        });
        if (seenUserIds.has(user.id)) {
          continue;
        }
        seenUserIds.add(user.id);
        const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
        rows.push({
          kind: "user",
          id: `user:${user.id}`,
          name: name || undefined,
          handle: user.username ? `@${user.username}` : undefined,
          rank: user.bot ? 0 : 1,
          raw: member,
        });
        if (rows.length >= limit) {
          return rows;
        }
      }
    }
  }
  return rows;
}

export function listDiscordDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return listDiscordDirectoryLive(params, "group");
}

export function listDiscordDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return listDiscordDirectoryLive(params, "user");
}
