import { RequestClient } from "@buape/carbon";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { makeProxyFetch } from "openclaw/plugin-sdk/infra-runtime";
import type { RetryConfig, RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { createDiscordRetryRunner } from "./retry.js";
import { normalizeDiscordToken } from "./token.js";

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

function resolveDiscordProxyUrl(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg?: ReturnType<typeof loadConfig>,
): string | undefined {
  const accountProxy = account.config.proxy?.trim();
  if (accountProxy) {
    return accountProxy;
  }
  const channelProxy = cfg?.channels?.discord?.proxy;
  if (typeof channelProxy !== "string") {
    return undefined;
  }
  const trimmed = channelProxy.trim();
  return trimmed || undefined;
}

export function resolveDiscordProxyFetchForAccount(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg?: ReturnType<typeof loadConfig>,
): typeof fetch | undefined {
  const proxy = resolveDiscordProxyUrl(account, cfg);
  return proxy ? makeProxyFetch(proxy) : undefined;
}

export function resolveDiscordProxyFetch(
  opts: Pick<DiscordClientOpts, "cfg" | "accountId">,
  cfg?: ReturnType<typeof loadConfig>,
): typeof fetch | undefined {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const account = resolveAccountWithoutToken({
    cfg: resolvedCfg,
    accountId: opts.accountId,
  });
  return resolveDiscordProxyFetchForAccount(account, resolvedCfg);
}

function resolveRest(
  token: string,
  account: ResolvedDiscordAccount,
  cfg: ReturnType<typeof loadConfig>,
  rest?: RequestClient,
) {
  if (rest) {
    return rest;
  }
  const proxyFetch = resolveDiscordProxyFetchForAccount(account, cfg);
  return new RequestClient(token, proxyFetch ? { fetch: proxyFetch } : undefined);
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
  const rest = resolveRest(token, account, resolvedCfg, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}
