import {
  type ChannelDoctorAdapter,
  type ChannelDoctorConfigMutation,
  type ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime-doctor";
import { isSlackMutableAllowEntry } from "./security-doctor.js";
import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
} from "./streaming-compat.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function normalizeSlackDmAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let changed = false;
  let updated: Record<string, unknown> = params.entry;
  const rawDm = updated.dm;
  const dm = asObjectRecord(rawDm) ? (structuredClone(rawDm) as Record<string, unknown>) : null;
  let dmChanged = false;

  const allowFromEqual = (a: unknown, b: unknown): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    const na = a.map((v) => String(v).trim()).filter(Boolean);
    const nb = b.map((v) => String(v).trim()).filter(Boolean);
    if (na.length !== nb.length) {
      return false;
    }
    return na.every((v, i) => v === nb[i]);
  };

  const topDmPolicy = updated.dmPolicy;
  const legacyDmPolicy = dm?.policy;
  if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
    updated = { ...updated, dmPolicy: legacyDmPolicy };
    changed = true;
    if (dm) {
      delete dm.policy;
      dmChanged = true;
    }
    params.changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
  } else if (
    topDmPolicy !== undefined &&
    legacyDmPolicy !== undefined &&
    topDmPolicy === legacyDmPolicy
  ) {
    if (dm) {
      delete dm.policy;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
    }
  }

  const topAllowFrom = updated.allowFrom;
  const legacyAllowFrom = dm?.allowFrom;
  if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
    updated = { ...updated, allowFrom: legacyAllowFrom };
    changed = true;
    if (dm) {
      delete dm.allowFrom;
      dmChanged = true;
    }
    params.changes.push(
      `Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`,
    );
  } else if (
    topAllowFrom !== undefined &&
    legacyAllowFrom !== undefined &&
    allowFromEqual(topAllowFrom, legacyAllowFrom)
  ) {
    if (dm) {
      delete dm.allowFrom;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
    }
  }

  if (dm && asObjectRecord(rawDm) && dmChanged) {
    const keys = Object.keys(dm);
    if (keys.length === 0) {
      if (updated.dm !== undefined) {
        const { dm: _ignored, ...rest } = updated;
        updated = rest;
        changed = true;
        params.changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
      }
    } else {
      updated = { ...updated, dm };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

function normalizeSlackStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const legacyStreaming = updated.streaming;
  const beforeStreaming = updated.streaming;
  const beforeNativeStreaming = updated.nativeStreaming;
  const resolvedStreaming = resolveSlackStreamingMode(updated);
  const resolvedNativeStreaming = resolveSlackNativeStreaming(updated);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof legacyStreaming === "boolean" ||
    (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming);
  if (!shouldNormalize) {
    return { entry: updated, changed: false };
  }

  let changed = false;
  if (beforeStreaming !== resolvedStreaming) {
    updated = { ...updated, streaming: resolvedStreaming };
    changed = true;
  }
  if (
    typeof beforeNativeStreaming !== "boolean" ||
    beforeNativeStreaming !== resolvedNativeStreaming
  ) {
    updated = { ...updated, nativeStreaming: resolvedNativeStreaming };
    changed = true;
  }
  if (hadLegacyStreamMode) {
    const { streamMode: _ignored, ...rest } = updated;
    updated = rest;
    changed = true;
    params.changes.push(
      formatSlackStreamModeMigrationMessage(params.pathPrefix, resolvedStreaming),
    );
  }
  if (typeof legacyStreaming === "boolean") {
    params.changes.push(
      formatSlackStreamingBooleanMigrationMessage(params.pathPrefix, resolvedNativeStreaming),
    );
  } else if (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming) {
    params.changes.push(
      `Normalized ${params.pathPrefix}.streaming (${legacyStreaming}) → (${resolvedStreaming}).`,
    );
  }

  return { entry: updated, changed };
}

function normalizeSlackCompatibilityConfig(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.slack);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const base = normalizeSlackDmAliases({
    entry: rawEntry,
    pathPrefix: "channels.slack",
    changes,
  });
  updated = base.entry;
  changed = base.changed;

  const baseStreaming = normalizeSlackStreamingAliases({
    entry: updated,
    pathPrefix: "channels.slack",
    changes,
  });
  updated = baseStreaming.entry;
  changed = changed || baseStreaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      let accountEntry = account;
      let accountChanged = false;
      const dm = normalizeSlackDmAliases({
        entry: account,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      accountEntry = dm.entry;
      accountChanged = dm.changed;
      const streaming = normalizeSlackStreamingAliases({
        entry: accountEntry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      accountEntry = streaming.entry;
      accountChanged = accountChanged || streaming.changed;
      if (accountChanged) {
        accounts[accountId] = accountEntry;
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
        slack: updated as unknown as NonNullable<OpenClawConfig["channels"]>["slack"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}

export function collectSlackMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];
  const addHits = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const text = String(entry).trim();
      if (!text || text === "*" || !isSlackMutableAllowEntry(text)) {
        continue;
      }
      hits.push({ path: pathLabel, entry: text });
    }
  };

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "slack")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addHits(`${scope.prefix}.allowFrom`, scope.account.allowFrom);
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addHits(`${scope.prefix}.dm.allowFrom`, dm.allowFrom);
    }
    const channels = asObjectRecord(scope.account.channels);
    if (!channels) {
      continue;
    }
    for (const [channelKey, channelRaw] of Object.entries(channels)) {
      const channel = asObjectRecord(channelRaw);
      if (channel) {
        addHits(`${scope.prefix}.channels.${channelKey}.users`, channel.users);
      }
    }
  }

  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across slack while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    "- Option A (break-glass): enable channels.slack.dangerousNameMatching=true for the affected scope.",
    "- Option B (recommended): resolve names to stable Slack IDs and rewrite the allowlist entries.",
  ];
}

function hasLegacySlackStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    (typeof entry.streaming === "string" && entry.streaming !== resolveSlackStreamingMode(entry))
  );
}

function hasLegacySlackAccountStreamingAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacySlackStreamingAliases(account));
}

const SLACK_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "slack"],
    message:
      "channels.slack.streamMode and boolean channels.slack.streaming are legacy; use channels.slack.streaming and channels.slack.nativeStreaming.",
    match: hasLegacySlackStreamingAliases,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      "channels.slack.accounts.<id>.streamMode and boolean channels.slack.accounts.<id>.streaming are legacy; use channels.slack.accounts.<id>.streaming and channels.slack.accounts.<id>.nativeStreaming.",
    match: hasLegacySlackAccountStreamingAliases,
  },
];

export const slackDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOrNested",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: ({ cfg }) => normalizeSlackCompatibilityConfig(cfg),
  collectMutableAllowlistWarnings: ({ cfg }) => collectSlackMutableAllowlistWarnings(cfg),
};
