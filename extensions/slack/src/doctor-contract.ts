import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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
    const na = a.map((value) => String(value).trim()).filter(Boolean);
    const nb = b.map((value) => String(value).trim()).filter(Boolean);
    if (na.length !== nb.length) {
      return false;
    }
    return na.every((value, index) => value === nb[index]);
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

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
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

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.slack);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const base = normalizeSlackDmAliases({
    entry: updated,
    pathPrefix: "channels.slack",
    changes,
  });
  updated = base.entry;
  changed = changed || base.changed;

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
      const dm = normalizeSlackDmAliases({
        entry: account,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      const streaming = normalizeSlackStreamingAliases({
        entry: dm.entry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      if (dm.changed || streaming.changed) {
        accounts[accountId] = streaming.entry;
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
