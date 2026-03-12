/**
 * Zulip Account Configuration
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { normalizeZulipBaseUrl } from "./client.js";

export type ZulipAccountConfig = {
  enabled?: boolean;
  email?: string;
  apiKey?: string;
  baseUrl?: string;
  name?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist";
  groupAllowFrom?: string[];
  requireMention?: boolean;
};

export type ResolvedZulipAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  email?: string;
  apiKey?: string;
  apiKeySource: "config" | "env" | "none";
  baseUrl?: string;
  config: ZulipAccountConfig;
};

function resolveZulipEnvCredentials(): {
  email?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  return {
    email: process.env.ZULIP_EMAIL || process.env.ZULIP_BOT_EMAIL,
    apiKey: process.env.ZULIP_API_KEY || process.env.ZULIP_BOT_API_KEY,
    baseUrl: process.env.ZULIP_URL || process.env.ZULIP_SITE,
  };
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const zulipConfig = cfg.channels?.zulip;
  if (!zulipConfig) {
    return [];
  }

  const ids = new Set<string>();
  
  // Check if base config has credentials
  if (zulipConfig.email || zulipConfig.apiKey || zulipConfig.baseUrl) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  
  // Check env vars
  const env = resolveZulipEnvCredentials();
  if (env.email || env.apiKey) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  
  // Check named accounts
  const accounts = zulipConfig.accounts;
  if (accounts && typeof accounts === "object") {
    for (const key of Object.keys(accounts)) {
      ids.add(key);
    }
  }

  return Array.from(ids);
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const { cfg, accountId: rawAccountId } = params;
  const accountId = rawAccountId?.trim() || DEFAULT_ACCOUNT_ID;
  
  const zulipConfig = cfg.channels?.zulip;
  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
  
  // Get account-specific config or base config
  const accountConfig: ZulipAccountConfig = isDefaultAccount
    ? (zulipConfig ?? {})
    : (zulipConfig?.accounts?.[accountId] ?? {});
  
  // Merge with base config for named accounts
  const baseConfig: ZulipAccountConfig = isDefaultAccount ? {} : (zulipConfig ?? {});
  const mergedConfig: ZulipAccountConfig = {
    ...baseConfig,
    ...accountConfig,
  };
  
  // Resolve credentials (config takes precedence over env)
  const env = resolveZulipEnvCredentials();
  const email = mergedConfig.email?.trim() || (isDefaultAccount ? env.email : undefined);
  const apiKey = mergedConfig.apiKey?.trim() || (isDefaultAccount ? env.apiKey : undefined);
  const baseUrl = normalizeZulipBaseUrl(
    mergedConfig.baseUrl || (isDefaultAccount ? env.baseUrl : undefined)
  );
  
  // Determine API key source
  let apiKeySource: "config" | "env" | "none" = "none";
  if (mergedConfig.apiKey?.trim()) {
    apiKeySource = "config";
  } else if (isDefaultAccount && env.apiKey) {
    apiKeySource = "env";
  }
  
  // Resolve enabled state
  const enabled = mergedConfig.enabled !== false;
  
  // Account name
  const name = mergedConfig.name?.trim() || accountId;

  return {
    accountId,
    name,
    enabled,
    email,
    apiKey,
    apiKeySource,
    baseUrl,
    config: mergedConfig,
  };
}
