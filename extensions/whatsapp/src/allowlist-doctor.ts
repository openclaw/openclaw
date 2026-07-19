// Whatsapp plugin module migrates shipped LID-form allowlist entries.
import { DEFAULT_ACCOUNT_ID, resolveAccountEntry } from "openclaw/plugin-sdk/account-core";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";
import { listWhatsAppAccountIds, resolveWhatsAppAuthDir } from "./accounts.js";
import { readWhatsAppLidToPnMappings } from "./lid-mapping-files.js";
import {
  parseWhatsAppDirectJidSyntax,
  stripWhatsAppTargetPrefixes,
} from "./whatsapp-jid-syntax.js";

function parseLidAllowlistEntry(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = parseWhatsAppDirectJidSyntax(stripWhatsAppTargetPrefixes(value));
  return parsed?.server === "lid" || parsed?.server === "hosted.lid" ? parsed : null;
}

const WHATSAPP_ALLOWLIST_KEYS = ["allowFrom", "groupAllowFrom"] as const;
type WhatsAppAllowlistKey = (typeof WHATSAPP_ALLOWLIST_KEYS)[number];

function containsLidAllowlist(value: unknown): boolean {
  const entry = asObjectRecord(value);
  return WHATSAPP_ALLOWLIST_KEYS.some((key) => {
    const entries = entry?.[key];
    return Array.isArray(entries) && entries.some(parseLidAllowlistEntry);
  });
}

export const whatsAppLidAllowlistLegacyRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "whatsapp"],
    message:
      "WhatsApp allowFrom or groupAllowFrom contains LID JIDs. Run doctor --fix to migrate entries backed by verified LID→PN mappings; replace any unresolved entries with E.164 numbers.",
    match: containsLidAllowlist,
  },
  {
    path: ["channels", "whatsapp", "accounts"],
    message:
      "A WhatsApp account allowFrom or groupAllowFrom contains LID JIDs. Run doctor --fix to migrate entries backed by verified LID→PN mappings; replace any unresolved entries with E.164 numbers.",
    match: (value) => {
      const accounts = asObjectRecord(value);
      return Boolean(accounts && Object.values(accounts).some(containsLidAllowlist));
    },
  },
];

function migrateLidAllowlistEntries(params: {
  entries: unknown[];
  configPath: string;
  mappingScopes: readonly (readonly string[])[];
  changes: string[];
  warnings: string[];
}): unknown[] | null {
  let changed = false;
  const entries = params.entries.map((entry) => {
    const parsed = parseLidAllowlistEntry(entry);
    if (!parsed) {
      return entry;
    }
    const mappingsByScope = params.mappingScopes.map((mappingDirs) =>
      readWhatsAppLidToPnMappings({ lid: parsed.user, mappingDirs }),
    );
    const mappings = new Set(mappingsByScope.flat());
    const everyScopeMapped = mappingsByScope.every((scopeMappings) => scopeMappings.length === 1);
    if (!everyScopeMapped || mappings.size !== 1) {
      const reason =
        mappings.size <= 1
          ? "no verified LID→PN mapping was found"
          : "conflicting LID→PN mappings were found";
      params.warnings.push(
        `${params.configPath} entry "${String(entry).trim()}" was not migrated because ${reason}; replace it with the sender's E.164 number.`,
      );
      return entry;
    }
    const phoneDigits = [...mappings][0]?.slice(1);
    if (!phoneDigits) {
      return entry;
    }
    changed = true;
    params.changes.push(
      `Migrated ${params.configPath} entry "${String(entry).trim()}" → "${phoneDigits}" using its verified LID→PN mapping.`,
    );
    return phoneDigits;
  });
  return changed ? entries : null;
}

function resolveAllowlistMappingScopes(params: {
  cfg: OpenClawConfig;
  accounts: Record<string, unknown> | null;
  key: WhatsAppAllowlistKey;
  accountId?: string;
}): string[][] {
  const ownerAccountId = params.accountId?.trim();
  const ownerId = ownerAccountId?.toLowerCase();
  if (ownerAccountId && ownerId !== DEFAULT_ACCOUNT_ID) {
    return [[resolveWhatsAppAuthDir({ cfg: params.cfg, accountId: ownerAccountId }).authDir]];
  }
  const defaultEntry = asObjectRecord(
    resolveAccountEntry(params.accounts ?? undefined, DEFAULT_ACCOUNT_ID),
  );
  const defaultOverridesRoot = Array.isArray(defaultEntry?.[params.key]);
  return listWhatsAppAccountIds(params.cfg).flatMap((accountId) => {
    const normalizedAccountId = accountId.trim().toLowerCase();
    const accountEntry = asObjectRecord(
      resolveAccountEntry(params.accounts ?? undefined, accountId),
    );
    const accountOverridesInherited = Array.isArray(accountEntry?.[params.key]);
    const inheritsOwner =
      ownerId === DEFAULT_ACCOUNT_ID
        ? normalizedAccountId === DEFAULT_ACCOUNT_ID || !accountOverridesInherited
        : !accountOverridesInherited &&
          (normalizedAccountId === DEFAULT_ACCOUNT_ID || !defaultOverridesRoot);
    if (!inheritsOwner) {
      return [];
    }
    return [[resolveWhatsAppAuthDir({ cfg: params.cfg, accountId }).authDir]];
  });
}

function migrateLidAllowlistFields(params: {
  entry: Record<string, unknown>;
  configPath: string;
  resolveMappingScopes: (key: WhatsAppAllowlistKey) => readonly (readonly string[])[];
  changes: string[];
  warnings: string[];
}): Record<string, unknown> | null {
  let nextEntry: Record<string, unknown> | null = null;
  for (const key of WHATSAPP_ALLOWLIST_KEYS) {
    const entries = params.entry[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    const migrated = migrateLidAllowlistEntries({
      entries,
      configPath: `${params.configPath}.${key}`,
      mappingScopes: params.resolveMappingScopes(key),
      changes: params.changes,
      warnings: params.warnings,
    });
    if (migrated) {
      nextEntry ??= { ...params.entry };
      nextEntry[key] = migrated;
    }
  }
  return nextEntry;
}

export function migrateWhatsAppLidAllowlistsConfig(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.whatsapp);
  if (!entry) {
    return { config: cfg, changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  let nextEntry = entry;
  const accounts = asObjectRecord(entry.accounts);
  const migratedRoot = migrateLidAllowlistFields({
    entry,
    configPath: "channels.whatsapp",
    resolveMappingScopes: (key) => resolveAllowlistMappingScopes({ cfg, accounts, key }),
    changes,
    warnings,
  });
  if (migratedRoot) {
    nextEntry = migratedRoot;
  }

  let accountsChanged = false;
  const nextAccounts = accounts
    ? Object.fromEntries(
        Object.entries(accounts).map(([accountId, rawAccount]) => {
          const account = asObjectRecord(rawAccount);
          if (!account) {
            return [accountId, rawAccount];
          }
          const migrated = migrateLidAllowlistFields({
            entry: account,
            configPath: `channels.whatsapp.accounts.${accountId}`,
            // Default-account policy is inherited by named accounts. Require a
            // unanimous mapping across every account that consumes each field.
            resolveMappingScopes: (key) =>
              resolveAllowlistMappingScopes({ cfg, accounts, key, accountId }),
            changes,
            warnings,
          });
          if (!migrated) {
            return [accountId, rawAccount];
          }
          accountsChanged = true;
          return [accountId, migrated];
        }),
      )
    : accounts;
  if (accountsChanged) {
    nextEntry = { ...nextEntry, accounts: nextAccounts };
  }
  if (nextEntry === entry) {
    return { config: cfg, changes, warnings: [...new Set(warnings)] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...channels,
        whatsapp: nextEntry,
      },
    } as OpenClawConfig,
    changes,
    warnings: [...new Set(warnings)],
  };
}
