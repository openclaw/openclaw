/**
 * Config adapter for the telegram-userbot channel.
 *
 * Resolves account configuration from the OpenClaw config object
 * using the `channels["telegram-userbot"]` section.
 */

import type {
  ChannelAccountSnapshot,
  ChannelConfigAdapter,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { TelegramUserbotConfig } from "../config-schema.js";

// ---------------------------------------------------------------------------
// Resolved account type
// ---------------------------------------------------------------------------

export type ResolvedTelegramUserbotAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  apiId: number;
  apiHash: string;
  config: TelegramUserbotConfig;
};

// ---------------------------------------------------------------------------
// Internal config helpers
// ---------------------------------------------------------------------------

const CHANNEL_KEY = "telegram-userbot";

type ChannelSection = TelegramUserbotConfig & {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, TelegramUserbotConfig & { enabled?: boolean; name?: string }>;
};

function getChannelSection(cfg: OpenClawConfig): ChannelSection | undefined {
  return cfg.channels?.[CHANNEL_KEY] as ChannelSection | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = getChannelSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

function mergeAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramUserbotConfig & { enabled?: boolean; name?: string } {
  const section = getChannelSection(cfg);
  const { accounts: _ignored, defaultAccount: _da, ...base } = (section ?? {}) as ChannelSection;
  const accountOverride = section?.accounts?.[accountId] ?? {};
  return { ...base, ...accountOverride };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listTelegramUserbotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelegramUserbotAccountId(cfg: OpenClawConfig): string {
  const section = getChannelSection(cfg);
  if (section?.defaultAccount?.trim()) {
    return section.defaultAccount.trim();
  }
  const ids = listTelegramUserbotAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTelegramUserbotAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramUserbotAccount {
  const normalized = normalizeAccountId(params.accountId);
  const merged = mergeAccountConfig(params.cfg, normalized);
  const baseEnabled = getChannelSection(params.cfg)?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const apiId = merged.apiId ?? 0;
  const apiHash = merged.apiHash ?? "";
  const configured = apiId > 0 && apiHash.length > 0;

  return {
    accountId: normalized,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    apiId,
    apiHash,
    config: merged as TelegramUserbotConfig,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const telegramUserbotConfigAdapter: ChannelConfigAdapter<ResolvedTelegramUserbotAccount> = {
  listAccountIds: (cfg) => listTelegramUserbotAccountIds(cfg),

  resolveAccount: (cfg, accountId) => resolveTelegramUserbotAccount({ cfg, accountId }),

  defaultAccountId: (cfg) => resolveDefaultTelegramUserbotAccountId(cfg),

  isConfigured: (account) => account.configured,

  isEnabled: (account) => account.enabled,

  describeAccount: (account): ChannelAccountSnapshot => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
  }),

  resolveAllowFrom: ({ cfg, accountId }) => {
    const account = resolveTelegramUserbotAccount({ cfg, accountId });
    return (account.config.allowFrom ?? []).map((entry) => String(entry));
  },

  formatAllowFrom: ({ allowFrom }) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^telegram-userbot:/i, "")),
};
