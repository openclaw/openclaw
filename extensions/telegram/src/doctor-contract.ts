import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelegramPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTelegramStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const beforeStreaming = updated.streaming;
  const resolved = resolveTelegramPreviewStreamMode(updated);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    (typeof beforeStreaming === "string" && beforeStreaming !== resolved);
  if (!shouldNormalize) {
    return { entry: updated, changed: false };
  }

  let changed = false;
  if (beforeStreaming !== resolved) {
    updated = { ...updated, streaming: resolved };
    changed = true;
  }
  if (hadLegacyStreamMode) {
    const { streamMode: _ignored, ...rest } = updated;
    updated = rest;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
    );
  }
  if (typeof beforeStreaming === "boolean") {
    params.changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
  } else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) {
    params.changes.push(
      `Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`,
    );
  }
  return { entry: updated, changed };
}

function hasLegacyTelegramStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    (typeof entry.streaming === "string" &&
      entry.streaming !== resolveTelegramPreviewStreamMode(entry))
  );
}

function hasLegacyTelegramAccountStreamingAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyTelegramStreamingAliases(account));
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
  {
    path: ["channels", "telegram", "groupMentionsOnly"],
    message:
      'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead (auto-migrated on load).',
  },
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.streamMode and boolean channels.telegram.streaming are legacy; use channels.telegram.streaming="off|partial|block".',
    match: hasLegacyTelegramStreamingAliases,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.streamMode and boolean channels.telegram.accounts.<id>.streaming are legacy; use channels.telegram.accounts.<id>.streaming="off|partial|block".',
    match: hasLegacyTelegramAccountStreamingAliases,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.telegram);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

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

  const base = normalizeTelegramStreamingAliases({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = base.entry;
  changed = changed || base.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const accountStreaming = normalizeTelegramStreamingAliases({
        entry: account,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        changes,
      });
      if (accountStreaming.changed) {
        accounts[accountId] = accountStreaming.entry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        telegram: updated as unknown as NonNullable<OpenClawConfig["channels"]>["telegram"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
