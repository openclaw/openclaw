/**
 * Directory adapter for the telegram-userbot channel.
 *
 * Provides self-info resolution and peer/group listing from config.
 * Live lookups (listPeersLive, listGroupsLive) are not implemented
 * because they require an active GramJS connection that is not always
 * available when the directory is queried.
 */

import type { ChannelDirectoryAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import type { TelegramUserbotConfig } from "../config-schema.js";
import { resolveTelegramUserbotAccount } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllowFromEntries(cfg: TelegramUserbotConfig): string[] {
  return (cfg.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^telegram-userbot:/i, ""));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const telegramUserbotDirectoryAdapter: ChannelDirectoryAdapter = {
  self: async ({ cfg, accountId }) => {
    const account = resolveTelegramUserbotAccount({ cfg, accountId });
    if (!account.configured || !account.enabled) return null;
    return {
      kind: "user",
      id: account.accountId,
      name: account.name ?? account.accountId,
    };
  },

  listPeers: async ({ cfg, accountId, query, limit }) => {
    const account = resolveTelegramUserbotAccount({ cfg, accountId });
    if (!account.configured || !account.enabled) return [];

    const entries = getAllowFromEntries(account.config);
    const q = query?.trim().toLowerCase() || "";

    return entries
      .filter((id) => (q ? id.toLowerCase().includes(q) : true))
      .slice(0, limit && limit > 0 ? limit : undefined)
      .map((id) => ({
        kind: "user" as const,
        id,
        name: /^@/.test(id) ? id : undefined,
      }));
  },

  listGroups: async () => [],
};
