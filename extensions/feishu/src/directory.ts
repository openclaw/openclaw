import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeers,
  type FeishuDirectoryGroup,
  type FeishuDirectoryPeer,
} from "./directory.static.js";

const MAX_FEISHU_DIRECTORY_PAGES = 100;

type LiveDirectoryParams = DirectoryConfigParams & { fallbackToStatic?: boolean };
type DirectoryEntry = FeishuDirectoryPeer | FeishuDirectoryGroup;

async function listFeishuDirectoryLive<TItem, TEntry extends DirectoryEntry>(
  params: LiveDirectoryParams & { filter?: (entry: TEntry) => boolean },
  options: {
    kind: "peer" | "group";
    fallback: (params: DirectoryConfigParams) => Promise<TEntry[]>;
    fetchPage: (
      client: ReturnType<typeof createFeishuClient>,
      pageSize: number,
      pageToken?: string,
    ) => Promise<{
      code?: number;
      msg?: string;
      data?: { items?: TItem[]; has_more?: boolean; page_token?: string };
    }>;
    toEntry: (item: TItem) => TEntry | undefined;
  },
): Promise<TEntry[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return options.fallback(params);
  }
  const label = `Feishu live ${options.kind}`;
  try {
    const client = createFeishuClient(account);
    const entries: TEntry[] = [];
    const limit = params.limit ?? 50;
    const q = normalizeLowercaseStringOrEmpty(params.query);
    const peers = options.kind === "peer";
    const pageSize = peers && q ? 50 : Math.min(limit, peers ? 50 : 100);
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    for (let page = 1; page <= MAX_FEISHU_DIRECTORY_PAGES; page += 1) {
      const response = await options.fetchPage(client, pageSize, pageToken);
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      for (const item of response.data?.items ?? []) {
        const entry = options.toEntry(item);
        if (
          entry &&
          (!q ||
            normalizeLowercaseStringOrEmpty(entry.id).includes(q) ||
            normalizeLowercaseStringOrEmpty(entry.name).includes(q)) &&
          (peers || !params.filter || params.filter(entry))
        ) {
          entries.push(entry);
        }
        if (entries.length >= limit) {
          // Peer lookup accepts the limit before examining continuation; groups
          // retain their page-token validation even when the result limit is met.
          if (peers) {
            return entries;
          }
          break;
        }
      }
      const nextPageToken = response.data?.has_more ? response.data.page_token : undefined;
      if (peers && response.data?.has_more && !nextPageToken) {
        throw new Error(`${label} directory returned an empty page token`);
      }
      if (nextPageToken && seenPageTokens.has(nextPageToken)) {
        throw new Error(`${label} directory returned a repeated page token`);
      }
      if (!nextPageToken) {
        return entries;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
      if (page === MAX_FEISHU_DIRECTORY_PAGES) {
        throw new Error(`${label} directory pagination limit exceeded`);
      }
      if (!peers && !(entries.length < limit)) {
        return entries;
      }
    }
    throw new Error(`${label} directory pagination limit exceeded`);
  } catch (err) {
    if (params.fallbackToStatic === false) {
      throw err instanceof Error ? err : new Error(`${label} lookup failed`);
    }
    return options.fallback(params);
  }
}

export function listFeishuDirectoryPeersLive(
  params: LiveDirectoryParams,
): Promise<FeishuDirectoryPeer[]> {
  return listFeishuDirectoryLive(params, {
    kind: "peer",
    fallback: listFeishuDirectoryPeers,
    fetchPage: (client, pageSize, pageToken) =>
      client.contact.user.list({ params: { page_size: pageSize, page_token: pageToken } }),
    toEntry: (user) =>
      user.open_id ? { kind: "user", id: user.open_id, name: user.name || undefined } : undefined,
  });
}

export function listFeishuDirectoryGroupsLive(
  params: LiveDirectoryParams & { filter?: (group: FeishuDirectoryGroup) => boolean },
): Promise<FeishuDirectoryGroup[]> {
  return listFeishuDirectoryLive(params, {
    kind: "group",
    fallback: listFeishuDirectoryGroups,
    fetchPage: (client, pageSize, pageToken) =>
      client.im.chat.list({ params: { page_size: pageSize, page_token: pageToken } }),
    toEntry: (chat) =>
      chat.chat_id ? { kind: "group", id: chat.chat_id, name: chat.name || undefined } : undefined,
  });
}
