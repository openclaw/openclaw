import type { WebClient } from "@slack/web-api";
import { createSlackTokenCacheKey } from "./client.js";

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

function getSlackDmChannelCache(client: WebClient): Map<string, string> {
  const existing = slackDmChannelCaches.get(client);
  if (existing) {
    return existing;
  }
  const cache = new Map<string, string>();
  slackDmChannelCaches.set(client, cache);
  return cache;
}

export function readCachedSlackDmChannelId(params: {
  cacheOwner: WebClient;
  accountId?: string;
  token: string;
  recipientId: string;
}): string | undefined {
  return getSlackDmChannelCache(params.cacheOwner).get(createSlackDmCacheKey(params));
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
  const cache = getSlackDmChannelCache(params.cacheOwner);
  const key = createSlackDmCacheKey(params);
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= SLACK_DM_CHANNEL_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
  cache.set(key, channelId);
}
