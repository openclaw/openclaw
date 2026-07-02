// Telegram helper module supports directory config behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolvedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-config-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveDefaultTelegramAccountSelection } from "./account-selection.js";
import { normalizeTelegramAllowFromEntries } from "./allow-from.js";

type TelegramDirectoryAccount = {
  config: TelegramAccountConfig;
};

function resolveTelegramDirectoryAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramDirectoryAccount {
  const resolvedAccountId = accountId?.trim()
    ? normalizeAccountId(accountId)
    : resolveDefaultTelegramAccountSelection(cfg).accountId;
  return {
    config: mergeTelegramAccountConfig(cfg, resolvedAccountId),
  };
}

export const listTelegramDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<TelegramDirectoryAccount>({
    kind: "user",
    resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
    resolveSources: (account) => [
      normalizeTelegramAllowFromEntries(account.config.allowFrom ?? []),
      Object.keys(account.config.dms ?? {}),
    ],
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
  });

export const listTelegramDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<TelegramDirectoryAccount>({
    kind: "group",
    resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
    resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
    normalizeId: (entry) => entry.trim() || null,
  });
