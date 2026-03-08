import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, InstagramAccountConfig, ResolvedInstagramAccount } from "./types.js";

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): InstagramAccountConfig | undefined {
  const accounts = cfg.channels?.instagram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as InstagramAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as InstagramAccountConfig | undefined) : undefined;
}

function mergeInstagramAccountConfig(cfg: CoreConfig, accountId: string): InstagramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = (cfg.channels?.instagram ?? {}) as InstagramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function listInstagramAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.instagram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

export function resolveDefaultInstagramAccountId(cfg: CoreConfig): string {
  const requested = normalizeOptionalAccountId(cfg.channels?.instagram?.defaultAccount);
  if (requested) {
    return requested;
  }
  return DEFAULT_ACCOUNT_ID;
}

export function resolveInstagramAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedInstagramAccount {
  const accountId = normalizeOptionalAccountId(params.accountId) ?? resolveDefaultInstagramAccountId(params.cfg);
  const config = mergeInstagramAccountConfig(params.cfg, accountId);
  const cliPath = normalizeResolvedSecretInputString({
    value: config.cliPath,
    path: `channels.instagram.accounts.${accountId}.cliPath`,
  }) || "instagram-cli";
  const cliArgs = Array.isArray(config.cliArgs)
    ? config.cliArgs.map((value) => String(value)).filter(Boolean)
    : [];
  const sessionUsername = config.sessionUsername?.trim() || undefined;
  const cwd = config.cwd?.trim() || undefined;
  return {
    accountId,
    enabled: config.enabled !== false,
    name: config.name?.trim() || undefined,
    configured: Boolean(cliPath),
    cliPath,
    cliArgs,
    cwd,
    sessionUsername,
    config,
  };
}
