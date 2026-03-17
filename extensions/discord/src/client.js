import { RequestClient } from "@buape/carbon";
import { loadConfig } from "../../../src/config/config.js";
import { createDiscordRetryRunner } from "../../../src/infra/retry-policy.js";
import { normalizeAccountId } from "../../../src/routing/session-key.js";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount
} from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";
function resolveToken(params) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`
    );
  }
  return fallback;
}
function resolveRest(token, rest) {
  return rest ?? new RequestClient(token);
}
function resolveAccountWithoutToken(params) {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || void 0,
    token: "",
    tokenSource: "none",
    config: merged
  };
}
function createDiscordRestClient(opts, cfg) {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const account = explicitToken ? resolveAccountWithoutToken({ cfg: resolvedCfg, accountId: opts.accountId }) : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token = explicitToken ?? resolveToken({
    accountId: account.accountId,
    fallbackToken: account.token
  });
  const rest = resolveRest(token, opts.rest);
  return { token, rest, account };
}
function createDiscordClient(opts, cfg) {
  const { token, rest, account } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose
  });
  return { token, rest, request };
}
function resolveDiscordRest(opts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}
export {
  createDiscordClient,
  createDiscordRestClient,
  resolveDiscordRest
};
