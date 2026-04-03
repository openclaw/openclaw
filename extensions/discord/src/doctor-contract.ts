import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeDiscordStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const beforeStreaming = updated.streaming;
  const resolved = resolveDiscordPreviewStreamMode(updated);
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
  if (
    params.pathPrefix.startsWith("channels.discord") &&
    resolved === "off" &&
    hadLegacyStreamMode
  ) {
    params.changes.push(
      `${params.pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${params.pathPrefix}.streaming="partial" to opt in explicitly.`,
    );
  }
  return { entry: updated, changed };
}

function hasLegacyDiscordStreamingAliases(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    (typeof entry.streaming === "string" &&
      entry.streaming !== resolveDiscordPreviewStreamMode(entry))
  );
}

function hasLegacyDiscordAccountStreamingAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyDiscordStreamingAliases(account));
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
      "channels.discord.streamMode and boolean channels.discord.streaming are legacy; use channels.discord.streaming.",
    match: hasLegacyDiscordStreamingAliases,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode and boolean channels.discord.accounts.<id>.streaming are legacy; use channels.discord.accounts.<id>.streaming.",
    match: hasLegacyDiscordAccountStreamingAliases,
  },
  {
    path: ["channels", "discord", "voice", "tts"],
    message:
      "channels.discord.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.voice.tts.providers.<provider> (auto-migrated on load).",
    match: hasLegacyTtsProviderKeys,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.voice.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use channels.discord.accounts.<id>.voice.tts.providers.<provider> (auto-migrated on load).",
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

  const streaming = normalizeDiscordStreamingAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
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
      const accountStreaming = normalizeDiscordStreamingAliases({
        entry: account,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      if (accountStreaming.changed) {
        accounts[accountId] = accountStreaming.entry;
        accountsChanged = true;
      }
      const accountVoice = asObjectRecord(accountStreaming.entry.voice);
      if (
        accountVoice &&
        migrateLegacyTtsConfig(
          asObjectRecord(accountVoice.tts),
          `channels.discord.accounts.${accountId}.voice.tts`,
          changes,
        )
      ) {
        accounts[accountId] = {
          ...accountStreaming.entry,
          voice: accountVoice,
        };
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
