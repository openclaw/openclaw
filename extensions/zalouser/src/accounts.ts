import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers, type OpenClawConfig } from "openclaw/plugin-sdk/zalouser";
import type { ResolvedZalouserAccount, ZalouserAccountConfig, ZalouserConfig } from "./types.js";
import { checkZaloAuthenticated, getZaloUserInfo } from "./zalo-js.js";

const {
  listAccountIds: listZalouserAccountIds,
  resolveDefaultAccountId: resolveDefaultZalouserAccountId,
} = createAccountListHelpers("zalouser");
export { listZalouserAccountIds, resolveDefaultZalouserAccountId };

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZalouserAccountConfig | undefined {
  const accounts = (cfg.channels?.zalouser as ZalouserConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZalouserAccountConfig | undefined;
}

function mergeZalouserAccountConfig(cfg: OpenClawConfig, accountId: string): ZalouserAccountConfig {
  const raw = (cfg.channels?.zalouser ?? {}) as ZalouserConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveProfile(config: ZalouserAccountConfig, accountId: string): string {
  if (config.profile?.trim()) {
    return config.profile.trim();
  }
  if (process.env.ZALOUSER_PROFILE?.trim()) {
    return process.env.ZALOUSER_PROFILE.trim();
  }
  if (process.env.ZCA_PROFILE?.trim()) {
    return process.env.ZCA_PROFILE.trim();
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  return "default";
}

export async function resolveZalouserAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ResolvedZalouserAccount> {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const profile = resolveProfile(merged, accountId);
  const authenticated = await checkZaloAuthenticated(profile);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    profile,
    authenticated,
    config: merged,
  };
}

export function resolveZalouserAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZalouserAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const profile = resolveProfile(merged, accountId);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    profile,
    authenticated: false,
    config: merged,
  };
}

export async function listEnabledZalouserAccounts(
  cfg: OpenClawConfig,
): Promise<ResolvedZalouserAccount[]> {
  const ids = listZalouserAccountIds(cfg);
  const accounts = await Promise.all(
    ids.map((accountId) => resolveZalouserAccount({ cfg, accountId })),
  );
  return accounts.filter((account) => account.enabled);
}

export async function getZcaUserInfo(
  profile: string,
): Promise<{ userId?: string; displayName?: string } | null> {
  const info = await getZaloUserInfo(profile);
  if (!info) {
    return null;
  }
  return {
    userId: info.userId,
    displayName: info.displayName,
  };
}

export { checkZaloAuthenticated as checkZcaAuthenticated };

export type { ResolvedZalouserAccount } from "./types.js";
