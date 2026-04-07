import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as runtimeDoctor from "openclaw/plugin-sdk/runtime-doctor";
import { resolveTelegramPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyTelegramStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  if (
    typeof entry.streamMode === "string" ||
    typeof entry.chunkMode === "string" ||
    typeof entry.blockStreaming === "boolean" ||
    typeof entry.blockStreamingCoalesce === "boolean" ||
    typeof entry.draftChunk === "boolean"
  ) {
    return true;
  }
  const streaming = entry.streaming;
  return typeof streaming === "string" || typeof streaming === "boolean";
}

function ensureNestedRecord(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObjectRecord(owner[key]);
  if (existing) {
    return { ...existing };
  }
  return {};
}

function normalizeLegacyTelegramStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  resolvedMode: string;
}): {
  entry: Record<string, unknown>;
  changed: boolean;
} {
  const beforeStreaming = params.entry.streaming;
  const hadLegacyStreamMode = params.entry.streamMode !== undefined;
  const hasLegacyFlatFields =
    params.entry.chunkMode !== undefined ||
    params.entry.blockStreaming !== undefined ||
    params.entry.blockStreamingCoalesce !== undefined ||
    params.entry.draftChunk !== undefined;
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    typeof beforeStreaming === "string" ||
    hasLegacyFlatFields;
  if (!shouldNormalize) {
    return { entry: params.entry, changed: false };
  }

  let updated = { ...params.entry };
  let changed = false;
  const streaming = ensureNestedRecord(updated, "streaming");
  const block = ensureNestedRecord(streaming, "block");
  const preview = ensureNestedRecord(streaming, "preview");

  if (
    (hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      typeof beforeStreaming === "string") &&
    streaming.mode === undefined
  ) {
    streaming.mode = params.resolvedMode;
    if (hadLegacyStreamMode) {
      params.changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "boolean") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "string") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    }
    changed = true;
  }
  if (hadLegacyStreamMode) {
    delete updated.streamMode;
    changed = true;
  }
  if (updated.chunkMode !== undefined && streaming.chunkMode === undefined) {
    streaming.chunkMode = updated.chunkMode;
    delete updated.chunkMode;
    params.changes.push(
      `Moved ${params.pathPrefix}.chunkMode → ${params.pathPrefix}.streaming.chunkMode.`,
    );
    changed = true;
  }
  if (updated.blockStreaming !== undefined && block.enabled === undefined) {
    block.enabled = updated.blockStreaming;
    delete updated.blockStreaming;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreaming → ${params.pathPrefix}.streaming.block.enabled.`,
    );
    changed = true;
  }
  if (updated.draftChunk !== undefined && preview.chunk === undefined) {
    preview.chunk = updated.draftChunk;
    delete updated.draftChunk;
    params.changes.push(
      `Moved ${params.pathPrefix}.draftChunk → ${params.pathPrefix}.streaming.preview.chunk.`,
    );
    changed = true;
  }
  if (updated.blockStreamingCoalesce !== undefined && block.coalesce === undefined) {
    block.coalesce = updated.blockStreamingCoalesce;
    delete updated.blockStreamingCoalesce;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreamingCoalesce → ${params.pathPrefix}.streaming.block.coalesce.`,
    );
    changed = true;
  }

  if (Object.keys(preview).length > 0) {
    streaming.preview = preview;
  }
  if (Object.keys(block).length > 0) {
    streaming.block = block;
  }
  updated.streaming = streaming;
  return { entry: updated, changed };
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
      'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "telegram"],
    message:
      "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: hasLegacyTelegramStreamingAliases,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      "channels.telegram.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: (value) =>
      runtimeDoctor.hasLegacyAccountStreamingAliases(value, hasLegacyTelegramStreamingAliases),
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

  const streaming = normalizeLegacyTelegramStreamingAliases({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
    resolvedMode: resolveTelegramPreviewStreamMode(updated),
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const accountStreaming = normalizeLegacyTelegramStreamingAliases({
        entry: account,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        changes,
        resolvedMode: resolveTelegramPreviewStreamMode(account),
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

  if (!changed && changes.length === 0) {
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
