import { RequestClient } from "@buape/carbon";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RetryConfig } from "openclaw/plugin-sdk/infra-runtime";
import type { RetryRunner } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { resolveDiscordRestFetch } from "./monitor/rest-fetch.js";
import { createDiscordRetryRunner } from "./retry.js";
import { normalizeDiscordToken } from "./token.js";

/** Cache proxy-aware fetch by proxy URL to avoid creating a ProxyAgent per send. */
const proxyFetchCache = new Map<string, typeof fetch>();

export function cachedProxyFetch(proxyUrl: string): typeof fetch {
  let cached = proxyFetchCache.get(proxyUrl);
  if (!cached) {
    cached = resolveDiscordRestFetch(proxyUrl, createNonExitingRuntime());
    proxyFetchCache.set(proxyUrl, cached);
  }
  return cached;
}

export type DiscordClientOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { accountId: string; fallbackToken?: string }) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function resolveRest(token: string, rest?: RequestClient, customFetch?: typeof fetch) {
  return rest ?? new RequestClient(token, customFetch ? { fetch: customFetch } : undefined);
}

function resolveAccountWithoutToken(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token: "",
    tokenSource: "none",
    config: merged,
  };
}

export function createDiscordRestClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
) {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const account = explicitToken
    ? resolveAccountWithoutToken({ cfg: resolvedCfg, accountId: opts.accountId })
    : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token =
    explicitToken ??
    resolveToken({
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? cachedProxyFetch(proxyUrl) : undefined;
  const rest = resolveRest(token, opts.rest, proxyFetch);
  return { token, rest, account, proxyFetch };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
): { token: string; rest: RequestClient; request: RetryRunner; proxyFetch?: typeof fetch } {
  const { token, rest, account, proxyFetch } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request, proxyFetch };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}
