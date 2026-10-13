import { hash } from "node:crypto";
import { type WebClientOptions, WebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import type { SlackProxyDispatcher } from "./client-options.js";
import {
  resolveSlackLookupClientOptions,
  resolveSlackReadClientOptions,
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";
import { readLruMapEntry } from "./monitor/lru-map-cache.js";

const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const SLACK_STARTUP_AUTH_TIMEOUT_MS = 10_000;
const SLACK_STARTUP_AUTH_RETRY_BUDGET_MS = 35_000;
const slackWriteClientCache = new Map<string, WebClient>();
const slackListenerWriteClientCache = new WeakMap<
  WebClient,
  { teamId: string | undefined; client?: WebClient }
>();

type SlackWriteClientCacheOptions = Pick<WebClientOptions, "slackApiUrl" | "teamId">;
type SlackFetch = NonNullable<WebClientOptions["fetch"]>;

export {
  resolveSlackWebClientOptions,
  resolveSlackWriteClientOptions,
  SLACK_DEFAULT_RETRY_OPTIONS,
  SLACK_WRITE_RETRY_OPTIONS,
} from "./client-options.js";

function createSlackClientFactory<Options extends WebClientOptions>(
  resolveOptions: (
    options?: Options,
    dispatcher?: SlackProxyDispatcher,
    assertDirectAdapterHandoff?: () => void,
  ) => WebClientOptions,
) {
  return (token: string, options?: Options, assertDirectAdapterHandoff?: () => void) =>
    new WebClient(token, resolveOptions(options, undefined, assertDirectAdapterHandoff));
}

// Shared clients stay timeout-free: Slack can commit a mutation before a late response.
export const createSlackWebClient = createSlackClientFactory(resolveSlackWebClientOptions);
export const createSlackLookupClient = createSlackClientFactory(resolveSlackLookupClientOptions);
export const createSlackWriteClient = createSlackClientFactory(resolveSlackWriteClientOptions);

export function createSlackReadClient(
  token: string,
  options: WebClientOptions = {},
  dispatcher?: SlackProxyDispatcher,
  assertDirectAdapterHandoff?: () => void,
) {
  return new WebClient(
    token,
    resolveSlackReadClientOptions(options, dispatcher, assertDirectAdapterHandoff),
  );
}

function createSlackStartupAuthFetch(baseFetch: SlackFetch): SlackFetch {
  const deadline = Date.now() + SLACK_STARTUP_AUTH_RETRY_BUDGET_MS;
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 429) {
      return response;
    }
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const remainingMs = Math.max(0, deadline - Date.now());
    if (!Number.isFinite(retryAfter) || retryAfter * 1000 <= remainingMs) {
      return response;
    }
    // Slack sleeps through Retry-After outside its per-attempt timeout. Wait only
    // within the startup budget, then let the retry policy terminate the call.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, remainingMs);
    });
    throw new Error("Slack startup auth retry budget exhausted after rate limit");
  };
}

export function createSlackStartupAuthClient(token: string, options: WebClientOptions = {}) {
  const resolvedOptions = resolveSlackWebClientOptions(options);
  const baseFetch = resolvedOptions.fetch;
  if (!baseFetch) {
    throw new Error("Slack startup auth fetch is unavailable");
  }
  return new WebClient(token, {
    ...resolvedOptions,
    fetch: createSlackStartupAuthFetch(baseFetch),
    retryConfig: {
      ...SLACK_DEFAULT_RETRY_OPTIONS,
      maxRetryTime: SLACK_STARTUP_AUTH_RETRY_BUDGET_MS,
    },
    timeout: SLACK_STARTUP_AUTH_TIMEOUT_MS,
  });
}

export function createSlackTokenCacheKey(token: string): string {
  return `sha256:${hash("sha256", token, "base64url")}`;
}

function slackWriteClientCacheKey(token: string, options: SlackWriteClientCacheOptions): string {
  const tokenKey = createSlackTokenCacheKey(token);
  const apiScope = options.slackApiUrl ? `:api:${options.slackApiUrl}` : "";
  const teamScope = options.teamId ? `:team:${options.teamId.trim().toLowerCase()}` : "";
  return `${tokenKey}${apiScope}${teamScope}`;
}

export function getSlackWriteClient(
  token: string,
  options: SlackWriteClientCacheOptions = {},
): WebClient {
  if (captureEffectAuthority().active) {
    return createSlackWriteClient(token, options);
  }
  const resolvedOptions = resolveSlackWriteClientOptions(options);
  const tokenKey = slackWriteClientCacheKey(token, resolvedOptions);
  const cached = readLruMapEntry(slackWriteClientCache, tokenKey);
  if (cached) {
    return cached;
  }
  const client = new WebClient(token, resolvedOptions);
  slackWriteClientCache.set(tokenKey, client);
  pruneMapToMaxSize(slackWriteClientCache, SLACK_WRITE_CLIENT_CACHE_MAX);
  return client;
}

export function getSlackListenerWriteClient(params: {
  listenerClient: WebClient;
  teamId?: string;
  clientOptions?: WebClientOptions;
}): WebClient | undefined {
  const token = params.listenerClient.token?.trim();
  const teamId = params.teamId?.trim().toUpperCase();
  if (!token) {
    return undefined;
  }
  const effectScoped = captureEffectAuthority().active;
  const cached = slackListenerWriteClientCache.get(params.listenerClient);
  if (cached) {
    // Bolt pools listener clients by authorized team. Reusing one for a
    // different team is invalid scope, not another write-client key.
    if (cached.teamId !== teamId) {
      return undefined;
    }
    if (!effectScoped && cached.client) {
      return cached.client;
    }
  }
  const headers = Object.fromEntries(
    Object.entries(params.clientOptions?.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  // Stream writes and upload completion are one-shot. Preserve transport and team
  // scope, but never inherit its retry policy or request deadline.
  const client = new WebClient(
    token,
    resolveSlackWriteClientOptions({
      ...params.clientOptions,
      headers,
      slackApiUrl: params.listenerClient.slackApiUrl,
      teamId,
      retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      timeout: 0,
    }),
  );
  if (!effectScoped) {
    slackListenerWriteClientCache.set(params.listenerClient, { teamId, client });
  } else if (!cached) {
    slackListenerWriteClientCache.set(params.listenerClient, { teamId });
  }
  return client;
}
