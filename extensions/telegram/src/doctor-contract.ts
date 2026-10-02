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

const webhookListenerMigration = createLegacyWebhookListenerDoctorContract({
  channelKey: "telegram",
  defaultPort: 8787,
  defaultHost: "127.0.0.1",
});

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
  let updated = includeGroupHistoryContext === "none" ? { ...rest, historyLimit: 0 } : rest;
  if (
    includeGroupHistoryContext === "recent" &&
    params.preserveRecentHistoryLimit !== undefined &&
    updated.historyLimit === undefined
  ) {
    updated = { ...updated, historyLimit: params.preserveRecentHistoryLimit };
  }
  const historyLimitNote =
    includeGroupHistoryContext === "none"
      ? " and set historyLimit to 0"
      : includeGroupHistoryContext === "recent" &&
          params.preserveRecentHistoryLimit !== undefined &&
          params.entry.historyLimit === undefined
        ? ` and set historyLimit to ${params.preserveRecentHistoryLimit}`
        : "";
  params.changes.push(
    `Removed ${params.pathPrefix}.includeGroupHistoryContext${historyLimitNote}; Telegram group history is always on for groups and bounded by historyLimit.`,
  );
  return { entry: updated, changed: true };
}

function resolveCompatibleDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} | null {
  const existingGroups = section.groups;
  if (existingGroups !== undefined && !asObjectRecord(existingGroups)) {
    return null;
  }
  const groups = asObjectRecord(existingGroups) ?? {};
  const defaultKey = "*";
  const existingEntry = groups[defaultKey];
  if (existingEntry !== undefined && !asObjectRecord(existingEntry)) {
    return null;
  }
  const entry = asObjectRecord(existingEntry) ?? {};
  return { groups, entry };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...webhookListenerMigration.legacyConfigRules,
  {
    path: ["channels", "telegram", "groupMentionsOnly"],
    message:
      'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
  },
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

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = webhookListenerMigration.normalizeCompatibilityConfig({ cfg });
  const changes = [...webhook.changes];
  const rawEntry = asObjectRecord(
    (webhook.config.channels as Record<string, unknown> | undefined)?.telegram,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const tuningKnobs = stripRetiredTelegramTuning(rawEntry, "channel");
  let updated = tuningKnobs.entry;
  let changed = webhook.config !== cfg || tuningKnobs.changed;
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
  changed = changed || retired.changed;

  if (updated.groupMentionsOnly !== undefined) {
    const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(updated);
    if (!defaultGroupEntry) {
      changes.push(
        "Skipped channels.telegram.groupMentionsOnly migration because channels.telegram.groups already has an incompatible shape; fix remaining issues manually.",
      );
    } else {
      const { groups, entry } = defaultGroupEntry;
      if (entry.requireMention === undefined) {
        entry.requireMention = updated.groupMentionsOnly;
        groups["*"] = entry;
        updated = { ...updated, groups };
        changes.push(
          'Moved channels.telegram.groupMentionsOnly → channels.telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed channels.telegram.groupMentionsOnly (channels.telegram.groups."*" already set).',
        );
      }
      const { groupMentionsOnly: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
    }
  }

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
  changed = changed || accounts.changed;

  if (!changed && changes.length === 0) {
    return { config: cfg, changes: [] };
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
  };
}
