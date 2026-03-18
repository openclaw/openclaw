import {
  applyDirectoryQueryAndLimit,
  collectNormalizedDirectoryIds,
  toDirectoryEntries,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { inspectDiscordAccount } from "../api.js";
import type { InspectedDiscordAccount } from "../api.js";

function inspectDiscordDirectoryAccount(
  params: DirectoryConfigParams,
): InspectedDiscordAccount | null {
  return inspectDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
}

export async function listDiscordDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  const account = inspectDiscordDirectoryAccount(params);
  if (!account || !("config" in account)) {
    return [];
  }

  const allowFrom = account.config.allowFrom ?? account.config.dm?.allowFrom ?? [];
  const guildUsers = Object.values(account.config.guilds ?? {}).flatMap((guild) => [
    ...(guild.users ?? []),
    ...Object.values(guild.channels ?? {}).flatMap((channel) => channel.users ?? []),
  ]);
  const ids = collectNormalizedDirectoryIds({
    sources: [allowFrom, Object.keys(account.config.dms ?? {}), guildUsers],
    normalizeId: (raw) => {
      const mention = raw.match(/^<@!?(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
      return /^\d+$/.test(cleaned) ? `user:${cleaned}` : null;
    },
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listDiscordDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  const account = inspectDiscordDirectoryAccount(params);
  if (!account || !("config" in account)) {
    return [];
  }

  const ids = collectNormalizedDirectoryIds({
    sources: Object.values(account.config.guilds ?? {}).map((guild) =>
      Object.keys(guild.channels ?? {}),
    ),
    normalizeId: (raw) => {
      const mention = raw.match(/^<#(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
      return /^\d+$/.test(cleaned) ? `channel:${cleaned}` : null;
    },
  });
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
