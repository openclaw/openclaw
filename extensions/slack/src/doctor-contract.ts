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
      const streaming = normalizeSlackStreamingAliases({
        entry: account,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      if (streaming.changed) {
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
