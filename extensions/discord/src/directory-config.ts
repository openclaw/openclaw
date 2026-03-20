import {
  listInspectedDirectoryEntriesFromSources,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { inspectDiscordAccount, type InspectedDiscordAccount } from "../api.js";

export async function listDiscordDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listInspectedDirectoryEntriesFromSources({
    ...params,
    kind: "user",
    inspectAccount: (cfg, accountId) =>
      inspectDiscordAccount({ cfg, accountId }) as InspectedDiscordAccount | null,
    resolveSources: (account) => {
      const allowFrom = account.config.allowFrom ?? account.config.dm?.allowFrom ?? [];
      const guildUsers = Object.values(account.config.guilds ?? {}).flatMap((guild) => [
        ...(guild.users ?? []),
        ...Object.values(guild.channels ?? {}).flatMap((channel) => channel.users ?? []),
      ]);
      return [allowFrom, Object.keys(account.config.dms ?? {}), guildUsers];
    },
    normalizeId: (raw) => {
      const mention = raw.match(/^<@!?(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
      return /^\d+$/.test(cleaned) ? `user:${cleaned}` : null;
    },
  });
}

export async function listDiscordDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listInspectedDirectoryEntriesFromSources({
    ...params,
    kind: "group",
    inspectAccount: (cfg, accountId) =>
      inspectDiscordAccount({ cfg, accountId }) as InspectedDiscordAccount | null,
    resolveSources: (account) =>
      Object.values(account.config.guilds ?? {}).map((guild) => Object.keys(guild.channels ?? {})),
    normalizeId: (raw) => {
      const mention = raw.match(/^<#(\d+)>$/);
      const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
      return /^\d+$/.test(cleaned) ? `channel:${cleaned}` : null;
    },
  });
}
