import type { WebClient } from "@slack/web-api";
import { createSlackTokenCacheKey } from "./client.js";
import { getOrCreateWeakOwnerMap, writeLruMapEntry } from "./monitor/lru-map-cache.js";

const SLACK_DM_CHANNEL_CACHE_MAX = 1024;
const slackDmChannelCaches = new WeakMap<WebClient, Map<string, string>>();

function createSlackDmCacheKey(params: {
  accountId?: string;
  token: string;
  recipientId: string;
}): string {
  return `${params.accountId ?? "default"}:${createSlackTokenCacheKey(params.token)}:${
    params.recipientId
  }`;
}

export function readCachedSlackDmChannelId(params: {
  cacheOwner: WebClient;
  accountId?: string;
  token: string;
  recipientId: string;
}): string | undefined {
  return slackDmChannelCaches.get(params.cacheOwner)?.get(createSlackDmCacheKey(params));
}

export function cacheSlackDmChannelId(
  params: {
    cacheOwner: WebClient;
    accountId?: string;
    token: string;
    recipientId: string;
  },
  channelId: string,
): void {
  const cache = getOrCreateWeakOwnerMap(slackDmChannelCaches, params.cacheOwner);
  const key = createSlackDmCacheKey(params);
  writeLruMapEntry(cache, key, channelId, SLACK_DM_CHANNEL_CACHE_MAX);
}
