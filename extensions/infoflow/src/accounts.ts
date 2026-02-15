/**
 * Infoflow account resolution and configuration helpers.
 * Handles multi-account support with config merging.
 */

import { DEFAULT_ACCOUNT_ID, normalizeAccountId, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { InfoflowAccountConfig, ResolvedInfoflowAccount } from "./types.js";

// ---------------------------------------------------------------------------
// Config Access Helpers
// ---------------------------------------------------------------------------

/**
 * Get the raw Infoflow channel section from config.
 */
export function getChannelSection(cfg: OpenClawConfig): InfoflowAccountConfig | undefined {
  return cfg.channels?.["infoflow"] as InfoflowAccountConfig | undefined;
}

// ---------------------------------------------------------------------------
// Account ID Resolution
// ---------------------------------------------------------------------------

/**
 * List all configured Infoflow account IDs.
 * Returns [DEFAULT_ACCOUNT_ID] if no accounts are configured (backward compatibility).
 */
export function listInfoflowAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = getChannelSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  return ids.length === 0 ? [DEFAULT_ACCOUNT_ID] : ids.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account ID for Infoflow.
 */
export function resolveDefaultInfoflowAccountId(cfg: OpenClawConfig): string {
  const channel = getChannelSection(cfg);
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listInfoflowAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

// ---------------------------------------------------------------------------
// Config Merging
// ---------------------------------------------------------------------------

/**
 * Merge top-level Infoflow config with account-specific overrides.
 * Account fields override base fields.
 */
function mergeInfoflowAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): {
  apiHost: string;
  checkToken: string;
  encodingAESKey: string;
  appKey: string;
  appSecret: string;
  enabled?: boolean;
  name?: string;
  robotName?: string;
  requireMention?: boolean;
} {
  const raw = getChannelSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = raw.accounts?.[accountId] ?? {};
  return { ...base, ...account } as {
    apiHost: string;
    checkToken: string;
    encodingAESKey: string;
    appKey: string;
    appSecret: string;
    enabled?: boolean;
    name?: string;
    robotName?: string;
    requireMention?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Account Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a complete Infoflow account with merged config.
 */
export function resolveInfoflowAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedInfoflowAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = getChannelSection(params.cfg)?.enabled !== false;
  const merged = mergeInfoflowAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const apiHost = merged.apiHost ?? "";
  const checkToken = merged.checkToken ?? "";
  const encodingAESKey = merged.encodingAESKey ?? "";
  const appKey = merged.appKey ?? "";
  const appSecret = merged.appSecret ?? "";
  const configured =
    Boolean(checkToken) && Boolean(encodingAESKey) && Boolean(appKey) && Boolean(appSecret);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    config: {
      enabled: merged.enabled,
      name: merged.name,
      apiHost,
      checkToken,
      encodingAESKey,
      appKey,
      appSecret,
      robotName: merged.robotName?.trim() || undefined,
      requireMention: merged.requireMention,
    },
  };
}
