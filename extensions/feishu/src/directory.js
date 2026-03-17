import {
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys
} from "openclaw/plugin-sdk/compat";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuTarget } from "./targets.js";
function toFeishuDirectoryPeers(ids) {
  return ids.map((id) => ({ kind: "user", id }));
}
function toFeishuDirectoryGroups(ids) {
  return ids.map((id) => ({ kind: "group", id }));
}
async function listFeishuDirectoryPeers(params) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
    allowFrom: account.config.allowFrom,
    map: account.config.dms,
    query: params.query,
    limit: params.limit,
    normalizeAllowFromId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    normalizeMapKeyId: (entry) => normalizeFeishuTarget(entry) ?? entry
  });
  return toFeishuDirectoryPeers(entries.map((entry) => entry.id));
}
async function listFeishuDirectoryGroups(params) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: account.config.groups,
    allowFrom: account.config.groupAllowFrom,
    query: params.query,
    limit: params.limit
  });
  return toFeishuDirectoryGroups(entries.map((entry) => entry.id));
}
async function listFeishuDirectoryPeersLive(params) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryPeers(params);
  }
  try {
    const client = createFeishuClient(account);
    const peers = [];
    const limit = params.limit ?? 50;
    const response = await client.contact.user.list({
      params: {
        page_size: Math.min(limit, 50)
      }
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
              name: name || void 0
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
async function listFeishuDirectoryGroupsLive(params) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return listFeishuDirectoryGroups(params);
  }
  try {
    const client = createFeishuClient(account);
    const groups = [];
    const limit = params.limit ?? 50;
    const response = await client.im.chat.list({
      params: {
        page_size: Math.min(limit, 100)
      }
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
              name: name || void 0
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
export {
  listFeishuDirectoryGroups,
  listFeishuDirectoryGroupsLive,
  listFeishuDirectoryPeers,
  listFeishuDirectoryPeersLive
};
