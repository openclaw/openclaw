import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramGroups = Record<string, TelegramGroupConfig>;

type MigrationScope = "account" | "global";

type TelegramGroupMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
  scopes: MigrationScope[];
};

function resolveAccountGroups(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramGroups | undefined {
  if (!accountId) {
    return undefined;
  }
  const normalized = normalizeAccountId(accountId);
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const exact = accounts[normalized];
  if (exact?.groups) {
    return exact.groups;
  }
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === normalizeLowercaseStringOrEmpty(normalized),
  );
  return matchKey ? accounts[matchKey]?.groups : undefined;
}

function migrateTelegramGroupsInPlace(
  groups: TelegramGroups | undefined,
  oldChatId: string,
  newChatId: string,
): { migrated: boolean; skippedExisting: boolean } {
  if (!groups || oldChatId === newChatId || !Object.hasOwn(groups, oldChatId)) {
    return { migrated: false, skippedExisting: false };
  }
  if (Object.hasOwn(groups, newChatId)) {
    return { migrated: false, skippedExisting: true };
  }
  groups[newChatId] = expectDefined(groups[oldChatId], "owned Telegram group config key");
  delete groups[oldChatId];
  return { migrated: true, skippedExisting: false };
}

export function migrateTelegramGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}): TelegramGroupMigrationResult {
  const scopes: MigrationScope[] = [];
  let skippedExisting = false;

  const migrationTargets: Array<{
    scope: MigrationScope;
    groups: TelegramGroups | undefined;
  }> = [
    { scope: "account", groups: resolveAccountGroups(params.cfg, params.accountId) },
    { scope: "global", groups: params.cfg.channels?.telegram?.groups },
  ];

  for (const target of migrationTargets) {
    const result = migrateTelegramGroupsInPlace(target.groups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      scopes.push(target.scope);
    }
    skippedExisting ||= result.skippedExisting;
  }

  return { migrated: scopes.length > 0, skippedExisting, scopes };
}
