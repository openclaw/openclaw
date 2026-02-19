import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { NostrProfile } from "./config-schema.js";
import { getPublicKeyFromPrivate } from "./nostr-bus.js";
import { DEFAULT_RELAYS } from "./nostr-bus.js";

export interface NostrAccountConfig {
  enabled?: boolean;
  name?: string;
  privateKey?: string;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: NostrProfile;
}

interface NostrChannelConfig extends NostrAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, NostrAccountConfig>;
}

export interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}

function isValidNostrPrivateKey(privateKey: string): boolean {
  try {
    getPublicKeyFromPrivate(privateKey);
    return true;
  } catch {
    return false;
  }
}

function getNostrChannelConfig(cfg: OpenClawConfig): NostrChannelConfig | undefined {
  const channel = (cfg.channels as Record<string, unknown> | undefined)?.nostr;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    return undefined;
  }
  return channel as NostrChannelConfig;
}

function resolveAccountConfig(
  channelCfg: NostrChannelConfig | undefined,
  accountId: string,
): NostrAccountConfig | undefined {
  const accounts = channelCfg?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

function mergeNostrAccountConfig(
  channelCfg: NostrChannelConfig | undefined,
  accountId: string,
): NostrAccountConfig {
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = channelCfg ?? {};
  const account = resolveAccountConfig(channelCfg, accountId) ?? {};
  return { ...base, ...account };
}

function sortAccountIds(ids: Set<string>): string[] {
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (!sorted.includes(DEFAULT_ACCOUNT_ID)) {
    return sorted;
  }
  return [DEFAULT_ACCOUNT_ID, ...sorted.filter((entry) => entry !== DEFAULT_ACCOUNT_ID)];
}

/**
 * List all configured Nostr account IDs
 */
export function listNostrAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getNostrChannelConfig(cfg);
  const ids = new Set<string>();

  if (channelCfg?.privateKey && isValidNostrPrivateKey(channelCfg.privateKey)) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  const configuredAccounts = channelCfg?.accounts;
  if (!configuredAccounts || typeof configuredAccounts !== "object") {
    return sortAccountIds(ids);
  }

  for (const key of Object.keys(configuredAccounts)) {
    if (!key.trim()) {
      continue;
    }
    const accountId = normalizeAccountId(key);
    const merged = mergeNostrAccountConfig(channelCfg, accountId);
    if (!merged.privateKey || !isValidNostrPrivateKey(merged.privateKey)) {
      continue;
    }
    ids.add(accountId);
  }

  return sortAccountIds(ids);
}

/**
 * Get the default account ID
 */
export function resolveDefaultNostrAccountId(cfg: OpenClawConfig): string {
  const ids = listNostrAccountIds(cfg);
  const channelCfg = getNostrChannelConfig(cfg);
  const configuredDefault = channelCfg?.defaultAccount?.trim();
  if (configuredDefault) {
    const normalized = normalizeAccountId(configuredDefault);
    if (ids.includes(normalized)) {
      return normalized;
    }
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Nostr account from config
 */
export function resolveNostrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(opts.accountId);
  const channelCfg = getNostrChannelConfig(opts.cfg);
  const mergedCfg = mergeNostrAccountConfig(channelCfg, accountId);

  const baseEnabled = channelCfg?.enabled !== false;
  const accountEnabled = mergedCfg.enabled !== false;
  const privateKey = mergedCfg.privateKey ?? "";
  const configured = privateKey.trim() !== "" && isValidNostrPrivateKey(privateKey);

  let publicKey = "";
  if (configured) {
    try {
      publicKey = getPublicKeyFromPrivate(privateKey);
    } catch {
      // Invalid key - leave publicKey empty, configured will indicate issues
    }
  }

  return {
    accountId,
    name: mergedCfg.name?.trim() || undefined,
    enabled: baseEnabled && accountEnabled,
    configured,
    privateKey,
    publicKey,
    relays: mergedCfg.relays ?? DEFAULT_RELAYS,
    profile: mergedCfg.profile,
    config: {
      enabled: mergedCfg.enabled,
      name: mergedCfg.name,
      privateKey: mergedCfg.privateKey,
      relays: mergedCfg.relays,
      dmPolicy: mergedCfg.dmPolicy,
      allowFrom: mergedCfg.allowFrom,
      profile: mergedCfg.profile,
    },
  };
}
