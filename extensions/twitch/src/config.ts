import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTwitchToken, type TwitchTokenResolution } from "./token.js";
import type { TwitchAccountConfig } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

export { DEFAULT_ACCOUNT_ID };

export type ResolvedTwitchAccount = TwitchAccountConfig & { accountId: string };

const { listAccountIds, resolveDefaultAccountId: resolveDefaultTwitchAccountId } =
  createAccountListHelpers("twitch", {
    normalizeAccountId,
    fallbackAccountIdWhenEmpty: false,
    hasImplicitDefaultAccount: (cfg) => {
      const twitch = cfg.channels?.twitch as Record<string, unknown> | undefined;
      return (
        typeof twitch?.username === "string" ||
        typeof twitch?.accessToken === "string" ||
        typeof twitch?.channel === "string"
      );
    },
  });

export { resolveDefaultTwitchAccountId };

type ResolvedTwitchAccountContext = {
  accountId: string;
  account: TwitchAccountConfig | null;
  tokenResolution: TwitchTokenResolution;
  configured: boolean;
  availableAccountIds: string[];
};

/**
 * Root credentials take precedence for the implicit default account; named
 * accounts only read their own account entry.
 */
export function getAccountConfig(
  coreConfig: unknown,
  accountId: string,
): TwitchAccountConfig | null {
  if (!coreConfig || typeof coreConfig !== "object") {
    return null;
  }

  const cfg = coreConfig as OpenClawConfig;
  const normalizedAccountId = normalizeAccountId(accountId);
  const twitch = cfg.channels?.twitch;
  const twitchRaw = twitch as Record<string, unknown> | undefined;
  const accounts = twitchRaw?.accounts as Record<string, TwitchAccountConfig> | undefined;

  if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
    const accountFromAccounts = resolveNormalizedAccountEntry(
      accounts,
      DEFAULT_ACCOUNT_ID,
      normalizeAccountId,
    );

    const baseLevel = {
      username: typeof twitchRaw?.username === "string" ? twitchRaw.username : undefined,
      accessToken: typeof twitchRaw?.accessToken === "string" ? twitchRaw.accessToken : undefined,
      clientId: typeof twitchRaw?.clientId === "string" ? twitchRaw.clientId : undefined,
      channel: typeof twitchRaw?.channel === "string" ? twitchRaw.channel : undefined,
      enabled: typeof twitchRaw?.enabled === "boolean" ? twitchRaw.enabled : undefined,
      allowFrom: Array.isArray(twitchRaw?.allowFrom) ? twitchRaw.allowFrom : undefined,
      allowedRoles: Array.isArray(twitchRaw?.allowedRoles) ? twitchRaw.allowedRoles : undefined,
      requireMention:
        typeof twitchRaw?.requireMention === "boolean" ? twitchRaw.requireMention : undefined,
      clientSecret:
        typeof twitchRaw?.clientSecret === "string" ? twitchRaw.clientSecret : undefined,
      refreshToken:
        typeof twitchRaw?.refreshToken === "string" ? twitchRaw.refreshToken : undefined,
      expiresIn: typeof twitchRaw?.expiresIn === "number" ? twitchRaw.expiresIn : undefined,
      obtainmentTimestamp:
        typeof twitchRaw?.obtainmentTimestamp === "number"
          ? twitchRaw.obtainmentTimestamp
          : undefined,
    };

    const merged: Partial<TwitchAccountConfig> = {
      ...accountFromAccounts,
      ...baseLevel,
    } as Partial<TwitchAccountConfig>;

    if (merged.username) {
      return merged as TwitchAccountConfig;
    }

    return accountFromAccounts || null;
  }

  return resolveNormalizedAccountEntry(accounts, normalizedAccountId, normalizeAccountId) || null;
}

export function resolveTwitchAccountContext(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwitchAccountContext {
  const resolvedAccountId = accountId?.trim()
    ? normalizeAccountId(accountId)
    : resolveDefaultTwitchAccountId(cfg);
  const account = getAccountConfig(cfg, resolvedAccountId);
  const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
  return {
    accountId: resolvedAccountId,
    account,
    tokenResolution,
    configured: account ? isAccountConfigured(account, tokenResolution.token) : false,
    availableAccountIds: listAccountIds(cfg),
  };
}

/** Keep runtime and setup on the same normalized, account-scoped credential path. */
function resolveTwitchAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwitchAccount {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultTwitchAccountId(cfg));
  const account = getAccountConfig(cfg, resolvedAccountId);
  return account
    ? { accountId: resolvedAccountId, ...account }
    : {
        accountId: resolvedAccountId,
        username: "",
        accessToken: "",
        clientId: "",
        channel: "",
        enabled: false,
      };
}

/** Share account selection and configured-state checks across both Twitch entrypoints. */
export const twitchConfigAdapter = {
  listAccountIds,
  resolveAccount: resolveTwitchAccount,
  defaultAccountId: resolveDefaultTwitchAccountId,
  resolveDefaultTo: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveTwitchAccountContext(cfg, accountId).account?.channel,
  isConfigured: (account: ResolvedTwitchAccount, cfg: OpenClawConfig) =>
    resolveTwitchAccountContext(cfg, account.accountId).configured,
  isEnabled: (account: ResolvedTwitchAccount | undefined) => account?.enabled !== false,
};
