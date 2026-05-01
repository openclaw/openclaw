import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RequestClient } from "../internal/discord.js";
import { canViewDiscordGuildChannel } from "../send.permissions.js";

export const DISCORD_ACCESS_GROUP_PREFIX = "accessGroup:";

export function parseDiscordAccessGroupEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(DISCORD_ACCESS_GROUP_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(DISCORD_ACCESS_GROUP_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

export async function resolveDiscordDmAccessGroupEntries(params: {
  cfg?: OpenClawConfig;
  allowFrom: string[];
  sender: { id: string };
  accountId: string;
  token?: string;
  rest?: RequestClient;
}): Promise<string[]> {
  const names = Array.from(
    new Set(
      params.allowFrom
        .map((entry) => parseDiscordAccessGroupEntry(entry))
        .filter((entry): entry is string => entry != null),
    ),
  );
  if (names.length === 0 || !params.cfg?.accessGroups) {
    return [];
  }

  const matched: string[] = [];
  for (const name of names) {
    const group = params.cfg.accessGroups[name];
    if (!group) {
      continue;
    }
    if (group.type !== "discord.channelAudience") {
      continue;
    }
    const membership = group.membership ?? "canViewChannel";
    if (membership !== "canViewChannel") {
      continue;
    }
    const allowed = await canViewDiscordGuildChannel(
      group.guildId,
      group.channelId,
      params.sender.id,
      {
        cfg: params.cfg,
        accountId: params.accountId,
        token: params.token,
        rest: params.rest,
      },
    ).catch((err) => {
      logVerbose(
        `discord: accessGroup:${name} lookup failed for user ${params.sender.id}: ${String(err)}`,
      );
      return false;
    });
    if (allowed) {
      matched.push(`${DISCORD_ACCESS_GROUP_PREFIX}${name}`);
    }
  }
  return matched;
}
