import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyAccountStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyDiscordStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  if (
    typeof entry.streamMode === "string" ||
    typeof entry.chunkMode === "string" ||
    typeof entry.blockStreaming === "boolean" ||
    typeof entry.blockStreamingCoalesce === "boolean" ||
    typeof entry.draftChunk === "boolean" ||
    (entry.draftChunk && typeof entry.draftChunk === "object")
  ) {
    return true;
  }
  const streaming = entry.streaming;
  return typeof streaming === "string" || typeof streaming === "boolean";
}

const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = asObjectRecord(value);
  if (!tts) {
    return false;
  }
  return LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(tts, key));
}

function hasLegacyDiscordAccountTtsProviderKeys(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((accountValue) => {
    const account = asObjectRecord(accountValue);
    const voice = asObjectRecord(account?.voice);
    return hasLegacyTtsProviderKeys(voice?.tts);
  });
}

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      mergeMissing(existing as Record<string, unknown>, value as Record<string, unknown>);
    }
  }
}

function getOrCreateTtsProviders(tts: Record<string, unknown>): Record<string, unknown> {
  const providers = asObjectRecord(tts.providers) ?? {};
  tts.providers = providers;
  return providers;
}

function mergeLegacyTtsProviderConfig(
  tts: Record<string, unknown>,
  legacyKey: string,
  providerId: string,
): boolean {
  const legacyValue = asObjectRecord(tts[legacyKey]);
  if (!legacyValue) {
    return false;
  }
  const providers = getOrCreateTtsProviders(tts);
  const existing = asObjectRecord(providers[providerId]) ?? {};
  const merged = structuredClone(existing);
  mergeMissing(merged, legacyValue);
  providers[providerId] = merged;
  delete tts[legacyKey];
  return true;
}

function migrateLegacyTtsConfig(
  tts: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): boolean {
  if (!tts) {
    return false;
  }
  let changed = false;
  if (mergeLegacyTtsProviderConfig(tts, "openai", "openai")) {
    changes.push(`Moved ${pathLabel}.openai → ${pathLabel}.providers.openai.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "elevenlabs", "elevenlabs")) {
    changes.push(`Moved ${pathLabel}.elevenlabs → ${pathLabel}.providers.elevenlabs.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "microsoft", "microsoft")) {
    changes.push(`Moved ${pathLabel}.microsoft → ${pathLabel}.providers.microsoft.`);
    changed = true;
  }
  if (mergeLegacyTtsProviderConfig(tts, "edge", "microsoft")) {
    changes.push(`Moved ${pathLabel}.edge → ${pathLabel}.providers.microsoft.`);
    changed = true;
  }
  return changed;
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "discord"],
    message:
      "channels.discord.streamMode, channels.discord.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: hasLegacyDiscordStreamingAliases,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.discord.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyDiscordStreamingAliases),
  },
  {
    path: ["channels", "discord", "voice", "tts"],
    message:
      'channels.discord.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.voice.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: hasLegacyTtsProviderKeys,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.accounts.<id>.voice.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: hasLegacyDiscordAccountTtsProviderKeys,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.discord);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;
  const shouldPromoteRootDmAllowFrom = !asObjectRecord(updated.accounts);

  const dm = normalizeLegacyDmAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
    promoteAllowFrom: shouldPromoteRootDmAllowFrom,
  });
  updated = dm.entry;
  changed = changed || dm.changed;

  const streaming = normalizeLegacyStreamingAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
    includePreviewChunk: true,
    resolvedMode: resolveDiscordPreviewStreamMode(updated),
    offModeLegacyNotice: (pathPrefix) =>
      `${pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${pathPrefix}.streaming.mode="partial" to opt in explicitly.`,
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
      let accountEntry = account;
      let accountChanged = false;
      const accountDm = normalizeLegacyDmAliases({
        entry: accountEntry,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      accountEntry = accountDm.entry;
      accountChanged = accountDm.changed;
      const accountStreaming = normalizeLegacyStreamingAliases({
        entry: accountEntry,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
        includePreviewChunk: true,
        resolvedMode: resolveDiscordPreviewStreamMode(accountEntry),
        offModeLegacyNotice: (pathPrefix) =>
          `${pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${pathPrefix}.streaming.mode="partial" to opt in explicitly.`,
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;
      const accountVoice = asObjectRecord(accountEntry.voice);
      if (
        accountVoice &&
        migrateLegacyTtsConfig(
          asObjectRecord(accountVoice.tts),
          `channels.discord.accounts.${accountId}.voice.tts`,
          changes,
        )
      ) {
        accountEntry = {
          ...accountEntry,
          voice: accountVoice,
        };
        accountChanged = true;
      }
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

  const voice = asObjectRecord(updated.voice);
  if (
    voice &&
    migrateLegacyTtsConfig(asObjectRecord(voice.tts), "channels.discord.voice.tts", changes)
  ) {
    updated = { ...updated, voice };
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
