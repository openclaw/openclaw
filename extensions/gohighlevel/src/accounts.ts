import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { GoHighLevelAccountConfig } from "./config-schema.js";

export type GoHighLevelCredentialSource = "env" | "inline" | "none";

export type ResolvedGoHighLevelAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: GoHighLevelAccountConfig;
  credentialSource: GoHighLevelCredentialSource;
  apiKey?: string;
  locationId?: string;
};

const ENV_API_KEY = "GHL_API_KEY";
const ENV_LOCATION_ID = "GHL_LOCATION_ID";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.["gohighlevel"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listGoHighLevelAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultGoHighLevelAccountId(cfg: OpenClawConfig): string {
  const channel = cfg.channels?.["gohighlevel"];
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listGoHighLevelAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): GoHighLevelAccountConfig | undefined {
  const accounts = cfg.channels?.["gohighlevel"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeGoHighLevelAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): GoHighLevelAccountConfig {
  const raw = cfg.channels?.["gohighlevel"] ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as GoHighLevelAccountConfig;
}

function resolveCredentials(params: { accountId: string; account: GoHighLevelAccountConfig }): {
  apiKey?: string;
  locationId?: string;
  source: GoHighLevelCredentialSource;
} {
  const { account, accountId } = params;

  // Inline config takes priority
  if (account.apiKey?.trim()) {
    return {
      apiKey: account.apiKey.trim(),
      locationId: account.locationId?.trim(),
      source: "inline",
    };
  }

  // Fall back to env vars for default account
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envKey = process.env[ENV_API_KEY]?.trim();
    if (envKey) {
      return {
        apiKey: envKey,
        locationId: account.locationId?.trim() || process.env[ENV_LOCATION_ID]?.trim(),
        source: "env",
      };
    }
  }

  return { source: "none" };
}

export function resolveGoHighLevelAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedGoHighLevelAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["gohighlevel"]?.enabled !== false;
  const merged = mergeGoHighLevelAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentials({ accountId, account: merged });

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    apiKey: credentials.apiKey,
    locationId: credentials.locationId,
  };
}

export function listEnabledGoHighLevelAccounts(cfg: OpenClawConfig): ResolvedGoHighLevelAccount[] {
  return listGoHighLevelAccountIds(cfg)
    .map((accountId) => resolveGoHighLevelAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
