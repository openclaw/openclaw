import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isZalouserMutableGroupEntry } from "./security-audit.js";

type ZalouserChannelsConfig = NonNullable<OpenClawConfig["channels"]>;

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyZalouserGroupAllowAlias(value: unknown): boolean {
  const group = asObjectRecord(value);
  return Boolean(group && typeof group.allow === "boolean");
}

function hasLegacyZalouserGroupAllowAliases(value: unknown): boolean {
  const groups = asObjectRecord(value);
  return Boolean(
    groups && Object.values(groups).some((group) => hasLegacyZalouserGroupAllowAlias(group)),
  );
}

function hasLegacyZalouserAccountGroupAllowAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => {
    const accountRecord = asObjectRecord(account);
    return Boolean(accountRecord && hasLegacyZalouserGroupAllowAliases(accountRecord.groups));
  });
}

function normalizeZalouserGroupAllowAliases(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups: Record<string, unknown> = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || typeof group.allow !== "boolean") {
      continue;
    }
    const nextGroup = { ...group };
    if (typeof nextGroup.enabled !== "boolean") {
      nextGroup.enabled = group.allow;
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled (${String(nextGroup.enabled)}).`,
    );
  }
  return { groups: nextGroups, changed };
}

function normalizeZalouserCompatibilityConfig(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const channels = asObjectRecord(cfg.channels);
  const zalouser = asObjectRecord(channels?.zalouser);
  if (!zalouser) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedZalouser: Record<string, unknown> = zalouser;
  let changed = false;

  const groups = asObjectRecord(updatedZalouser.groups);
  if (groups) {
    const normalized = normalizeZalouserGroupAllowAliases({
      groups,
      pathPrefix: "channels.zalouser.groups",
      changes,
    });
    if (normalized.changed) {
      updatedZalouser = { ...updatedZalouser, groups: normalized.groups };
      changed = true;
    }
  }

  const accounts = asObjectRecord(updatedZalouser.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts: Record<string, unknown> = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const accountGroups = asObjectRecord(account.groups);
      if (!accountGroups) {
        continue;
      }
      const normalized = normalizeZalouserGroupAllowAliases({
        groups: accountGroups,
        pathPrefix: `channels.zalouser.accounts.${accountId}.groups`,
        changes,
      });
      if (!normalized.changed) {
        continue;
      }
      nextAccounts[accountId] = {
        ...account,
        groups: normalized.groups,
      };
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedZalouser = { ...updatedZalouser, accounts: nextAccounts };
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
        zalouser: updatedZalouser as ZalouserChannelsConfig["zalouser"],
      },
    },
    changes,
  };
}

const ZALOUSER_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "zalouser", "groups"],
    message:
      'channels.zalouser.groups.<id>.allow is legacy; use channels.zalouser.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyZalouserGroupAllowAliases,
  },
  {
    path: ["channels", "zalouser", "accounts"],
    message:
      'channels.zalouser.accounts.<id>.groups.<id>.allow is legacy; use channels.zalouser.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyZalouserAccountGroupAllowAliases,
  },
];

export const legacyConfigRules = ZALOUSER_LEGACY_CONFIG_RULES;

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeZalouserCompatibilityConfig(params.cfg);
}

export const collectZalouserMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "zalouser",
    detector: isZalouserMutableGroupEntry,
    collectLists: (scope) => {
      const groups = asObjectRecord(scope.account.groups);
      return groups
        ? [
            {
              pathLabel: `${scope.prefix}.groups`,
              list: Object.keys(groups),
            },
          ]
        : [];
    },
  });

export const zalouserDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules,
  normalizeCompatibilityConfig,
  collectMutableAllowlistWarnings: collectZalouserMutableAllowlistWarnings,
};
