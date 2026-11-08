import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import {
  asObjectRecord,
  createLegacyWebhookListenerDoctorContract,
  hasLegacyAccountStreamingAliases,
  normalizeChannelAccounts,
  type CompatMutationResult,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { listTelegramAccountIds } from "./account-selection.js";
import {
  DEFAULT_TELEGRAM_WEBHOOK_PATH,
  resolveTelegramGatewayWebhookUrl,
  resolveTelegramWebhookPathConflict,
} from "./webhook-route.js";

const webhookListenerMigration = createLegacyWebhookListenerDoctorContract({
  channelKey: "telegram",
  defaultPort: 8787,
  defaultHost: "127.0.0.1",
});
export const { historicalWebhookListener } = webhookListenerMigration;

const RETIRED_TUNING_KEYS = new Set([
  "timeoutSeconds",
  "mediaGroupFlushMs",
  "pollingStallThresholdMs",
  "retry",
  "errorCooldownMs",
]);

function stripRetiredTelegramTuning(
  entry: Record<string, unknown>,
  scope: "channel" | "account" | "chat" | "topic",
): CompatMutationResult {
  let changed = false;
  const updated = { ...entry };
  for (const key of scope === "channel" || scope === "account"
    ? RETIRED_TUNING_KEYS
    : ["errorCooldownMs"]) {
    if (Object.hasOwn(updated, key)) {
      delete updated[key];
      changed = true;
    }
  }
  // Account IDs and sender-policy keys can equal retired setting names. Descend
  // only through Telegram's config maps, never arbitrary object properties.
  const maps = scope === "topic" ? [] : scope === "chat" ? ["topics"] : ["groups", "direct"];
  if (scope === "channel") {
    maps.push("accounts");
  }
  for (const key of maps) {
    const entries = asObjectRecord(entry[key]);
    if (!entries) {
      continue;
    }
    const nextEntries = { ...entries };
    for (const [id, value] of Object.entries(entries)) {
      const child = asObjectRecord(value);
      if (!child) {
        continue;
      }
      const next = stripRetiredTelegramTuning(
        child,
        key === "accounts" ? "account" : key === "topics" ? "topic" : "chat",
      );
      if (next.changed) {
        nextEntries[id] = next.entry;
        updated[key] = nextEntries;
        changed = true;
      }
    }
  }
  return { entry: changed ? updated : entry, changed };
}

function hasRetiredTelegramGroupHistoryContextConfig(value: unknown): boolean {
  return asObjectRecord(value)?.includeGroupHistoryContext !== undefined;
}

function removeRetiredTelegramGroupHistoryContextConfig(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  preserveRecentHistoryLimit?: number;
}): { entry: Record<string, unknown>; changed: boolean } {
  if (params.entry.includeGroupHistoryContext === undefined) {
    return { entry: params.entry, changed: false };
  }
  const { includeGroupHistoryContext, ...rest } = params.entry;
  const historyLimit =
    includeGroupHistoryContext === "none"
      ? 0
      : includeGroupHistoryContext === "recent" &&
          params.preserveRecentHistoryLimit !== undefined &&
          params.entry.historyLimit === undefined
        ? params.preserveRecentHistoryLimit
        : undefined;
  const updated = historyLimit === undefined ? rest : { ...rest, historyLimit };
  const historyLimitNote =
    historyLimit === undefined ? "" : ` and set historyLimit to ${historyLimit}`;
  params.changes.push(
    `Removed ${params.pathPrefix}.includeGroupHistoryContext${historyLimitNote}; Telegram group history is always on for groups and bounded by historyLimit.`,
  );
  return { entry: updated, changed: true };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...webhookListenerMigration.legacyConfigRules,
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.includeGroupHistoryContext was removed; Telegram group history is always on for groups and bounded by historyLimit. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramGroupHistoryContextConfig,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.includeGroupHistoryContext was removed; Telegram group history is always on for groups and bounded by historyLimit. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, hasRetiredTelegramGroupHistoryContextConfig),
  },
];

export function normalizeHistoricalWebhookConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const historicalWebhookAccountIds =
    cfg.channels?.telegram?.enabled === false
      ? []
      : listTelegramAccountIds(cfg).filter((accountId) => {
          const account = mergeTelegramAccountConfig(cfg, accountId);
          if (account.enabled === false || !account.webhookUrl?.trim()) {
            return false;
          }
          const path = account.webhookPath ?? DEFAULT_TELEGRAM_WEBHOOK_PATH;
          const gatewayUrl = resolveTelegramGatewayWebhookUrl(cfg, path);
          return (
            !gatewayUrl ||
            URL.parse(account.webhookUrl)?.href !== gatewayUrl ||
            resolveTelegramWebhookPathConflict(path) !== undefined
          );
        });
  return {
    ...webhookListenerMigration.normalizeCompatibilityConfig({ cfg }),
    historicalWebhookAccountIds,
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = normalizeHistoricalWebhookConfig({ cfg });
  const { historicalWebhookAccountIds } = webhook;
  const changes = [...webhook.changes];
  const rawEntry = asObjectRecord(
    (webhook.config.channels as Record<string, unknown> | undefined)?.telegram,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [], historicalWebhookAccountIds };
  }

  const tuningKnobs = stripRetiredTelegramTuning(rawEntry, "channel");
  let updated = tuningKnobs.entry;
  if (tuningKnobs.changed) {
    changes.push("Removed retired Telegram tuning knobs.");
  }
  const rootGroupHistoryContextMode = updated.includeGroupHistoryContext;
  const rootGroupHistoryLimitBeforeMigration =
    typeof updated.historyLimit === "number"
      ? updated.historyLimit
      : (cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT);

  const retired = removeRetiredTelegramGroupHistoryContextConfig({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = retired.entry;

  const accounts = normalizeChannelAccounts({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
    normalizeAccount: ({ account, pathPrefix, changes: accountChanges }) =>
      removeRetiredTelegramGroupHistoryContextConfig({
        entry: account,
        pathPrefix,
        changes: accountChanges,
        ...(rootGroupHistoryContextMode === "none"
          ? { preserveRecentHistoryLimit: rootGroupHistoryLimitBeforeMigration }
          : {}),
      }),
  });
  updated = accounts.entry;

  if (webhook.config === cfg && updated === rawEntry && changes.length === 0) {
    return { config: cfg, changes: [], historicalWebhookAccountIds };
  }
  return {
    config: {
      ...webhook.config,
      channels: {
        ...webhook.config.channels,
        telegram: updated as unknown as NonNullable<OpenClawConfig["channels"]>["telegram"],
      } as OpenClawConfig["channels"],
    },
    changes,
    historicalWebhookAccountIds,
  };
}
