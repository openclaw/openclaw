import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolvedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-config-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveDefaultTelegramAccountSelection } from "./account-selection.js";

function resolveTelegramDirectoryConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramAccountConfig {
  const resolvedAccountId = accountId?.trim()
    ? normalizeAccountId(accountId)
    : resolveDefaultTelegramAccountSelection(cfg).accountId;
  return mergeTelegramAccountConfig(cfg, resolvedAccountId);
}

export const listTelegramDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<TelegramAccountConfig>({
    kind: "user",
    resolveAccount: resolveTelegramDirectoryConfig,
    resolveSources: (config) => [
      mapAllowFromEntries(config.allowFrom),
      Object.keys(config.dms ?? {}),
    ],
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      return /^-?\d+$/.test(trimmed) || trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
  });

export const listTelegramDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<TelegramAccountConfig>({
    kind: "group",
    resolveAccount: resolveTelegramDirectoryConfig,
    resolveSources: (config) => [Object.keys(config.groups ?? {})],
    normalizeId: (entry) => entry.trim() || null,
  });
