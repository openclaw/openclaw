import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeers,
  type FeishuDirectoryGroup,
  type FeishuDirectoryPeer,
} from "./directory.static.js";

export { listFeishuDirectoryGroups, listFeishuDirectoryPeers } from "./directory.static.js";

export async function listFeishuDirectoryPeersLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
  fallbackToStatic?: boolean;
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

    if (response.code !== 0) {
      throw new Error(response.msg || `code ${response.code}`);
    }

    for (const user of response.data?.items ?? []) {
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

    return peers;
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error("Feishu live peer lookup failed");
    }
    return listFeishuDirectoryPeers(params);
  }
}

export async function listFeishuDirectoryGroupsLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
  fallbackToStatic?: boolean;
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

    if (response.code !== 0) {
      throw new Error(response.msg || `code ${response.code}`);
    }

    for (const chat of response.data?.items ?? []) {
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

    return groups;
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error("Feishu live group lookup failed");
    }
    return listFeishuDirectoryGroups(params);
  }
}
