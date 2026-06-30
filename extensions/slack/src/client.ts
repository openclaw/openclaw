// Slack plugin module implements client behavior.
import { createHash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import { resolveSlackWebClientOptions, resolveSlackWriteClientOptions } from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = new Map<string, WebClient>();

type SlackWriteClientCacheOptions = Pick<WebClientOptions, "slackApiUrl">;

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

export function createSlackTokenCacheKey(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

function slackWriteClientCacheKey(token: string, options: SlackWriteClientCacheOptions): string {
  const tokenKey = createSlackTokenCacheKey(token);
  return options.slackApiUrl ? `${tokenKey}:api:${options.slackApiUrl}` : tokenKey;
}

export function getSlackWriteClient(
  token: string,
  options: SlackWriteClientCacheOptions = {},
): WebClient {
  const resolvedOptions = resolveSlackWriteClientOptions(options);
  const tokenKey = slackWriteClientCacheKey(token, resolvedOptions);
  const cached = slackWriteClientCache.get(tokenKey);
  if (cached) {
    slackWriteClientCache.delete(tokenKey);
    slackWriteClientCache.set(tokenKey, cached);
    return cached;
  }
  const client = new WebClient(token, resolvedOptions);
  if (slackWriteClientCache.size >= SLACK_WRITE_CLIENT_CACHE_MAX) {
    const oldestTokenKey = slackWriteClientCache.keys().next().value;
    if (oldestTokenKey) {
      slackWriteClientCache.delete(oldestTokenKey);
    }
  }
  slackWriteClientCache.set(tokenKey, client);
  return client;
}

export function clearSlackWriteClientCacheForTest(): void {
  slackWriteClientCache.clear();
}
