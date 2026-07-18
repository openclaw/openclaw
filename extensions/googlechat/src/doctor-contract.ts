// Googlechat plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord, defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";

type GoogleChatChannelsConfig = NonNullable<OpenClawConfig["channels"]>;

// Googlechat's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode (legacy streamMode is removed outright above), so
// only the delivery flat aliases migrate. Account merge replaces the root
// streaming object wholesale (resolveMergedAccountConfig without a streaming
// deep-merge), and named accounts layer as {...accounts.default, ...named}
// (accounts.ts), so a materialized named-account streaming object must inherit
// accounts.default fields over root ones. Seeding is handled below instead of
// via accountStreamingReplacesRoot because the generic root-only seed would
// drop accounts.default block-streaming when a named account only had chunkMode.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "googlechat",
  streaming: { defaultMode: "partial", deliveryOnly: true },
});

function hasLegacyGoogleChatStreamMode(value: unknown): boolean {
  return asObjectRecord(value)?.streamMode !== undefined;
}

function hasLegacyGoogleChatGroupAllowAlias(value: unknown): boolean {
  const groups = asObjectRecord(asObjectRecord(value)?.groups);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => Object.hasOwn(asObjectRecord(group) ?? {}, "allow"));
}

function hasLegacyAccountAliases(value: unknown, match: (entry: unknown) => boolean): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => match(account));
}

function normalizeGoogleChatGroups(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || !Object.hasOwn(group, "allow")) {
      continue;
    }
    const nextGroup = { ...group };
    if (nextGroup.enabled === undefined) {
      nextGroup.enabled = group.allow;
      params.changes.push(
        `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.${groupId}.allow (${params.pathPrefix}.${groupId}.enabled already set).`,
      );
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
  }
  return { groups: nextGroups, changed };
}

function normalizeGoogleChatEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  let changed = false;

  if (updated.streamMode !== undefined) {
    updated = { ...updated };
    delete updated.streamMode;
    params.changes.push(`Removed ${params.pathPrefix}.streamMode (legacy key no longer used).`);
    changed = true;
  }

  const groups = asObjectRecord(updated.groups);
  if (groups) {
    const normalized = normalizeGoogleChatGroups({
      groups,
      pathPrefix: `${params.pathPrefix}.groups`,
      changes: params.changes,
    });
    if (normalized.changed) {
      updated = { ...updated, groups: normalized.groups };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "googlechat"],
    message: "channels.googlechat.streamMode is legacy and no longer used; it is removed on load.",
    match: hasLegacyGoogleChatStreamMode,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      "channels.googlechat.accounts.<id>.streamMode is legacy and no longer used; it is removed on load.",
    match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatStreamMode),
  },
  {
    path: ["channels", "googlechat"],
    message:
      'channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyGoogleChatGroupAllowAlias,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatGroupAllowAlias),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

function normalizeRetiredGoogleChatKeys(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord(
    (cfg.channels as Record<string, unknown> | undefined)?.googlechat,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed;

  const root = normalizeGoogleChatEntry({
    entry: updated,
    pathPrefix: "channels.googlechat",
    changes,
  });
  updated = root.entry;
  changed = root.changed;

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const normalized = normalizeGoogleChatEntry({
        entry: account,
        pathPrefix: `channels.googlechat.accounts.${accountId}`,
        changes,
      });
      if (!normalized.changed) {
        continue;
      }
      nextAccounts[accountId] = normalized.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
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
        googlechat: updated as GoogleChatChannelsConfig["googlechat"],
      },
    },
    changes,
  };
}

/** Deep-fills fields missing from target with copies of source values. */
function fillMissingStreamingFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): { value: Record<string, unknown>; filled: boolean } {
  let filled = false;
  const value = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) {
      continue;
    }
    const existing = value[key];
    if (existing === undefined) {
      value[key] = structuredClone(sourceValue);
      filled = true;
      continue;
    }
    const existingRecord = asObjectRecord(existing);
    const sourceRecord = asObjectRecord(sourceValue);
    if (!existingRecord || !sourceRecord) {
      continue;
    }
    const merged = fillMissingStreamingFields(existingRecord, sourceRecord);
    if (merged.filled) {
      value[key] = merged.value;
      filled = true;
    }
  }
  return { value, filled };
}

// The runtime merge replaces `streaming` wholesale per layer (named account >
// accounts.default > root), while the retired flat keys resolved per key
// across those layers. Account objects that migration materializes must carry
// the settings the account previously inherited, or `doctor --fix` silently
// changes effective delivery behavior for that account.
function seedMigratedAccountStreaming(params: {
  cfg: OpenClawConfig;
  accountsWithoutStreamingBefore: ReadonlySet<string>;
  changes: string[];
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.googlechat);
  const accounts = asObjectRecord(entry?.accounts);
  if (!entry || !accounts) {
    return params.cfg;
  }
  const rootStreaming = asObjectRecord(entry.streaming);
  // Account lookup treats keys case-insensitively (resolveAccountEntry), so
  // `accounts.Default` is the default account too.
  const defaultKey = Object.hasOwn(accounts, "default")
    ? "default"
    : Object.keys(accounts).find((key) => key.trim().toLowerCase() === "default");

  let accountsChanged = false;
  const nextAccounts = { ...accounts };
  // Seed the default account first: its final object is the inheritance
  // source for named accounts (default replaces root wholesale when set).
  const seedOrder = Object.keys(accounts).toSorted((left, right) =>
    left === defaultKey ? -1 : right === defaultKey ? 1 : left.localeCompare(right),
  );
  for (const accountId of seedOrder) {
    const account = asObjectRecord(nextAccounts[accountId]);
    const created = asObjectRecord(account?.streaming);
    if (!account || !created || !params.accountsWithoutStreamingBefore.has(accountId)) {
      continue;
    }
    const defaultStreaming = defaultKey
      ? asObjectRecord(asObjectRecord(nextAccounts[defaultKey])?.streaming)
      : null;
    const inheritedSource =
      accountId === defaultKey ? rootStreaming : (defaultStreaming ?? rootStreaming);
    if (!inheritedSource) {
      continue;
    }
    const seeded = fillMissingStreamingFields(created, inheritedSource);
    if (!seeded.filled) {
      continue;
    }
    nextAccounts[accountId] = { ...account, streaming: seeded.value };
    accountsChanged = true;
    const sourcePath =
      accountId === defaultKey
        ? "channels.googlechat.streaming"
        : "effective channels.googlechat streaming defaults";
    params.changes.push(
      `Copied ${sourcePath} into channels.googlechat.accounts.${accountId}.streaming to keep inherited settings while migrating flat streaming keys.`,
    );
  }
  if (!accountsChanged) {
    return params.cfg;
  }
  return {
    ...params.cfg,
    channels: {
      ...channels,
      googlechat: { ...entry, accounts: nextAccounts },
    },
  } as OpenClawConfig;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const retired = normalizeRetiredGoogleChatKeys(cfg);
  const accountsBefore = asObjectRecord(
    asObjectRecord((retired.config.channels as Record<string, unknown> | undefined)?.googlechat)
      ?.accounts,
  );
  const accountsWithoutStreamingBefore = new Set(
    Object.entries(accountsBefore ?? {})
      .filter(([, account]) => asObjectRecord(account)?.streaming === undefined)
      .map(([accountId]) => accountId),
  );
  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg: retired.config,
    changes: retired.changes,
  });
  return {
    config: seedMigratedAccountStreaming({
      cfg: aliases.config,
      accountsWithoutStreamingBefore,
      changes: aliases.changes,
    }),
    changes: aliases.changes,
  };
}
