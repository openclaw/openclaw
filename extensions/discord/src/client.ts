import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { getGateway } from "./monitor/gateway-registry.js";
import { resolveDiscordProxyFetchForAccount } from "./proxy-fetch.js";
import { createDiscordRequestClient } from "./proxy-request-client.js";
import { createDiscordRetryRunner } from "./retry.js";
import type { DiscordReactOpts, DiscordRuntimeAccountContext } from "./send.types.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = DiscordReactOpts;

export function createDiscordRuntimeAccountContext(
  params: DiscordRuntimeAccountContext,
): DiscordRuntimeAccountContext {
  return {
    cfg: params.cfg,
    accountId: normalizeAccountId(params.accountId),
  };
}

export function resolveDiscordClientAccountContext(
  opts: Pick<DiscordClientOpts, "cfg" | "accountId">,
  runtime?: Pick<RuntimeEnv, "error">,
) {
  const resolvedCfg = requireRuntimeConfig(opts.cfg, "Discord client");
  const accountId = normalizeAccountId(opts.accountId);
  const config = mergeDiscordAccountConfig(resolvedCfg, accountId);
  const account: ResolvedDiscordAccount = {
    accountId,
    enabled: resolvedCfg.channels?.discord?.enabled !== false && config.enabled !== false,
    name: normalizeOptionalString(config.name),
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    config,
  };
  return {
    cfg: resolvedCfg,
    account,
    proxyFetch: resolveDiscordProxyFetchForAccount(account, resolvedCfg, runtime),
  };
}

function resolveToken(params: {
  account: ResolvedDiscordAccount;
  accountId: string;
  fallbackToken?: string;
}) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    if (params.account.tokenStatus === "configured_unavailable") {
      throw new Error(
        `Discord bot token configured for account "${params.accountId}" is unavailable; resolve SecretRefs against the active runtime snapshot before using this account.`,
      );
    }
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

export function createDiscordRestClient(opts: DiscordClientOpts) {
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const proxyContext = resolveDiscordClientAccountContext(opts);
  const resolvedCfg = proxyContext.cfg;
  const account = explicitToken
    ? proxyContext.account
    : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token =
    explicitToken ??
    resolveToken({
      account,
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const { rest, signal, timeoutMs } = opts;
  if (rest) {
    return { token, rest, account };
  }
  const proxyFetch =
    proxyContext.proxyFetch ?? resolveDiscordProxyFetchForAccount(account, resolvedCfg);
  return {
    token,
    rest: createDiscordRequestClient(token, {
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
      ...(signal ? { signal } : {}),
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    }),
    account,
  };
}

export function createDiscordClient(opts: DiscordClientOpts) {
  const { token, rest, account: restAccount } = createDiscordRestClient(opts);
  const account = normalizeDiscordToken(opts.token, "channels.discord.token")
    ? resolveDiscordAccount({ cfg: opts.cfg, accountId: opts.accountId })
    : restAccount;
  // Explicit-token REST clients retain their normalized gateway identity; outbound
  // projection consumers use the canonical configured account returned below.
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    verbose: opts.verbose,
    isGatewayDisconnected: () => {
      const gateway = getGateway(restAccount.accountId);
      return gateway !== undefined && !gateway.isConnected;
    },
  });
  return { token, rest, request, account };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts).rest;
}
