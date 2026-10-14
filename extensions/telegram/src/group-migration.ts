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

export function migrateTelegramGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}): TelegramGroupMigrationResult {
  const scopes: MigrationScope[] = [];
  let skippedExisting = false;

  const migrationTargets = [
    { scope: "account", groups: resolveAccountGroups(params.cfg, params.accountId) },
    { scope: "global", groups: params.cfg.channels?.telegram?.groups },
  ] as const;

  const { oldChatId, newChatId } = params;
  for (const { scope, groups } of migrationTargets) {
    if (!groups || oldChatId === newChatId || !Object.hasOwn(groups, oldChatId)) {
      continue;
    }
    if (Object.hasOwn(groups, newChatId)) {
      skippedExisting = true;
      continue;
    }
    groups[newChatId] = expectDefined(groups[oldChatId], "owned Telegram group config key");
    delete groups[oldChatId];
    scopes.push(scope);
  }

  return { migrated: scopes.length > 0, skippedExisting, scopes };
}
