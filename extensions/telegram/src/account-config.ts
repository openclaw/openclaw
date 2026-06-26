// Telegram helper module supports account config behavior.
import {
  normalizeAccountId,
  resolveNormalizedAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeTelegramAllowFromEntry,
  type TelegramAllowFromEntry,
} from "./allow-from.js";

function hasWildcardAllowFrom(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeTelegramAllowFromEntry(entry) === "*")
  );
}

function hasRestrictiveAllowFrom(value: unknown): value is TelegramAllowFromEntry[] {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      const normalized = normalizeTelegramAllowFromEntry(entry);
      return normalized.length > 0 && normalized !== "*";
    })
  );
}

function dropWildcardAllowFrom(value: TelegramAllowFromEntry[]): TelegramAllowFromEntry[] {
  return value.filter((entry) => normalizeTelegramAllowFromEntry(entry) !== "*");
}

function resolveMergedAllowFrom(params: {
  baseAllowFrom?: TelegramAllowFromEntry[];
  accountAllowFrom?: TelegramAllowFromEntry[];
}): TelegramAllowFromEntry[] | undefined {
  const { baseAllowFrom, accountAllowFrom } = params;
  if (hasRestrictiveAllowFrom(baseAllowFrom) && hasWildcardAllowFrom(accountAllowFrom)) {
    const accountRestrictiveEntries = Array.isArray(accountAllowFrom)
      ? dropWildcardAllowFrom(accountAllowFrom)
      : [];
    return accountRestrictiveEntries.length > 0 ? accountRestrictiveEntries : baseAllowFrom;
  }
  return accountAllowFrom ?? baseAllowFrom;
}

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveNormalizedAccountEntry(
    cfg.channels?.telegram?.accounts,
    normalized,
    normalizeAccountId,
  );
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};

  // Multi-account bots must not inherit channel-level groups unless explicitly set.
  // Single-account bots fall back to root `channels.telegram.groups` when the
  // account does not declare its own groups — including the empty-literal case
  // `accounts.<id>.groups: {}`, which is almost always a config-migration
  // artifact rather than an intentional "block all" declaration (use
  // `groupPolicy: "disabled"` for that).
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const hasAccountGroups = account.groups && Object.keys(account.groups).length > 0;
  const groups = isMultiAccount
    ? account.groups
    : hasAccountGroups
      ? account.groups
      : channelGroups;
  const allowFrom = resolveMergedAllowFrom({
    baseAllowFrom: base.allowFrom,
    accountAllowFrom: account.allowFrom,
  });
  const capabilities =
    Array.isArray(account.capabilities) && account.capabilities.length === 0
      ? base.capabilities
      : (account.capabilities ?? base.capabilities);

  return { ...base, ...account, allowFrom, capabilities, groups };
}
