import {
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
} from "openclaw/plugin-sdk";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuTarget } from "./targets.js";

export type FeishuDirectoryPeer = {
  kind: "user";
  id: string;
  name?: string;
};

export type FeishuDirectoryGroup = {
  kind: "group";
  id: string;
  name?: string;
};

export async function listFeishuDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  return listDirectoryUserEntriesFromAllowFromAndMapKeys({
    allowFrom: account.config.allowFrom,
    map: account.config.dms,
    query: params.query,
    limit: params.limit,
    normalizeAllowFromId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    normalizeMapKeyId: (entry) => normalizeFeishuTarget(entry) ?? entry,
  });
}

export async function listFeishuDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  return listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: account.config.groups,
    allowFrom: account.config.groupAllowFrom,
    query: params.query,
    limit: params.limit,
  });
}

export async function listFeishuDirectoryPeersLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryPeers(params);
  }

  try {
    const client = createFeishuClient(account);
    const peers: FeishuDirectoryPeer[] = [];
    const limit = params.limit ?? 50;

    const response = await client.contact.user.list({
      params: {
        page_size: Math.min(limit, 50),
      },
    });

    if (response.code === 0 && response.data?.items) {
      for (const user of response.data.items) {
        if (user.open_id) {
          const q = params.query?.trim().toLowerCase() || "";
          const name = user.name || "";
          if (!q || user.open_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
            peers.push({
              kind: "user",
              id: user.open_id,
              name: name || undefined,
            });
          }
        }
        if (peers.length >= limit) {
          break;
        }
      }
    }

    return peers;
  } catch {
    return listFeishuDirectoryPeers(params);
  }
}

export async function listFeishuDirectoryGroupsLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryGroups(params);
  }

  try {
    const client = createFeishuClient(account);
    const groups: FeishuDirectoryGroup[] = [];
    const limit = params.limit ?? 50;

    const response = await client.im.chat.list({
      params: {
        page_size: Math.min(limit, 100),
      },
    });

    if (response.code === 0 && response.data?.items) {
      for (const chat of response.data.items) {
        if (chat.chat_id) {
          const q = params.query?.trim().toLowerCase() || "";
          const name = chat.name || "";
          if (!q || chat.chat_id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
            groups.push({
              kind: "group",
              id: chat.chat_id,
              name: name || undefined,
            });
          }
        }
        if (groups.length >= limit) {
          break;
        }
      }
    }

    return groups;
  } catch {
    return listFeishuDirectoryGroups(params);
  }
}
