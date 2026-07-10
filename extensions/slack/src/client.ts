// Slack plugin module implements client behavior.
import { createHash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = new Map<string, WebClient>();
let slackListenerDeliveryClientCache = new WeakMap<
  WebClient,
  { teamId: string; client: WebClient }
>();

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

export function getSlackListenerDeliveryClient(params: {
  listenerClient: WebClient;
  teamId: string;
  clientOptions?: WebClientOptions;
}): WebClient | undefined {
  const token = params.listenerClient.token?.trim();
  if (!token) {
    return undefined;
  }
  const teamId = params.teamId.trim().toUpperCase();
  if (!teamId) {
    return undefined;
  }
  const cached = slackListenerDeliveryClientCache.get(params.listenerClient);
  if (cached) {
    // Bolt App.processEvent pools message listener clients by authorizeResult.teamId.
    // Reusing that object for another event team is invalid scope, not a new key.
    return cached.teamId === teamId ? cached.client : undefined;
  }
  const headers = Object.fromEntries(
    Object.entries(params.clientOptions?.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  // Bolt exposes the finalized WebClient options. Clone that public transport
  // contract, then override only the team scope and one-shot write retry policy.
  const client = new WebClient(
    token,
    resolveSlackWriteClientOptions({
      ...params.clientOptions,
      headers,
      slackApiUrl: params.listenerClient.slackApiUrl,
      teamId,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
    }),
  );
  slackListenerDeliveryClientCache.set(params.listenerClient, { teamId, client });
  return client;
}

export function clearSlackWriteClientCacheForTest(): void {
  slackWriteClientCache.clear();
  slackListenerDeliveryClientCache = new WeakMap();
}
