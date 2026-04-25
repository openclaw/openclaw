import { type WebClientOptions, WebClient } from "@slack/web-api";
import { resolveSlackWebClientOptions, resolveSlackWriteClientOptions } from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = new Map<string, WebClient>();

export {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}

export function createSlackWriteClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWriteClientOptions(options));
}

export function getSlackWriteClient(token: string): WebClient {
  const cached = slackWriteClientCache.get(token);
  if (cached) {
    slackWriteClientCache.delete(token);
    slackWriteClientCache.set(token, cached);
    return cached;
  }
  const client = createSlackWriteClient(token);
  if (slackWriteClientCache.size >= SLACK_WRITE_CLIENT_CACHE_MAX) {
    const oldestToken = slackWriteClientCache.keys().next().value;
    if (oldestToken) {
      slackWriteClientCache.delete(oldestToken);
    }
  }
  slackWriteClientCache.set(token, client);
  return client;
}

export function clearSlackWriteClientCacheForTest(): void {
  slackWriteClientCache.clear();
}
