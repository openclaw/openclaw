import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// The narrow activation subpath avoids realtime-voice's agent-consult/session
// graph, which doctor enumeration must not cold-load.
import {
  isSupportedRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
} from "openclaw/plugin-sdk/realtime-voice-activation";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelAccounts,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

const RETIRED_TUNING_KEYS = new Set([
  "gatewayInfoTimeoutMs",
  "gatewayReadyTimeoutMs",
  "gatewayRuntimeReadyTimeoutMs",
  "eventQueue",
  "retry",
]);

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "discord",
  streaming: {
    // Runtime mode resolution dropped legacy streamMode reads; the doctor
    // resolver keeps them so migration preserves configured intent.
    defaultMode: "off",
    includePreviewChunk: true,
  },
  // Discord's account merge replaces the root streaming object wholesale
  // (`streaming` not in mergeDiscordAccountConfig nestedObjectKeys), so doctor
  // must seed materialized account objects with the inherited root settings.
  accountStreamingReplacesRoot: true,
  dm: { root: true, accounts: true },
});

function hasUnsupportedRealtimeWakeNamesInVoice(value: unknown): boolean {
  const voice = asObjectRecord(value);
  const realtime = asObjectRecord(voice?.realtime);
  const wakeNames = realtime?.wakeNames;
  return Array.isArray(wakeNames)
    ? wakeNames.length === 0 ||
        wakeNames.some(
          (wakeName) =>
            typeof wakeName === "string" && !isSupportedRealtimeVoiceActivationName(wakeName),
        )
    : false;
}

function hasUnsupportedDiscordRealtimeWakeNames(value: unknown): boolean {
  return hasUnsupportedRealtimeWakeNamesInVoice(asObjectRecord(value)?.voice);
}

function normalizeUnsupportedRealtimeWakeNames(
  entry: Record<string, unknown>,
  pathPrefix: string,
  changes: string[],
): { entry: Record<string, unknown>; changed: boolean } {
  const voice = asObjectRecord(entry.voice);
  const realtime = asObjectRecord(voice?.realtime);
  const wakeNames = realtime?.wakeNames;
  if (!voice || !realtime || !Array.isArray(wakeNames)) {
    return { entry, changed: false };
  }

  let normalized = 0;
  let removed = 0;
  const nextWakeNames = wakeNames.flatMap((wakeName) => {
    if (typeof wakeName !== "string" || isSupportedRealtimeVoiceActivationName(wakeName)) {
      return [wakeName];
    }
    const nextWakeName = normalizeRealtimeVoiceActivationNamePrefix(wakeName);
    if (!nextWakeName) {
      removed += 1;
      return [];
    }
    normalized += 1;
    return [nextWakeName];
  });
  if (wakeNames.length > 0 && normalized === 0 && removed === 0) {
    return { entry, changed: false };
  }
  const dedupedWakeNames = Array.from(new Set(nextWakeNames));

  if (wakeNames.length === 0) {
    changes.push(
      `Removed empty ${pathPrefix}.voice.realtime.wakeNames; unset wake names use the default agent/OpenClaw fallback.`,
    );
  }
  const nextRealtime = { ...realtime };
  if (dedupedWakeNames.length > 0) {
    nextRealtime.wakeNames = dedupedWakeNames;
  } else {
    delete nextRealtime.wakeNames;
  }
  if (normalized > 0) {
    changes.push(
      `Shortened ${normalized} unsupported ${pathPrefix}.voice.realtime.wakeNames entries to one or two words.`,
    );
  }
  if (removed > 0) {
    changes.push(
      `Removed ${removed} unsupported ${pathPrefix}.voice.realtime.wakeNames entries with no usable words.`,
    );
  }
  return {
    entry: {
      ...entry,
      voice: {
        ...voice,
        realtime: nextRealtime,
      },
    },
    changed: true,
  };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "discord"],
    message:
      'channels.discord.voice.realtime.wakeNames entries longer than two words are unsupported; use one- or two-word activation names. Run "openclaw doctor --fix".',
    match: hasUnsupportedDiscordRealtimeWakeNames,
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.voice.realtime.wakeNames entries longer than two words are unsupported; use one- or two-word activation names. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, hasUnsupportedDiscordRealtimeWakeNames),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  const tuningKnobs = stripRetiredChannelKeys({
    cfg: aliases.config,
    channelId: "discord",
    keys: RETIRED_TUNING_KEYS,
    scope: "root-and-accounts",
  });
  const rawEntry = asObjectRecord(
    (tuningKnobs.config.channels as Record<string, unknown> | undefined)?.discord,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }
  let updated = rawEntry;
  let changed = tuningKnobs.config !== cfg;
  if (tuningKnobs.changed) {
    changes.push("Removed retired Discord tuning knobs.");
  }

  const accounts = normalizeChannelAccounts({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
    normalizeAccount: ({ account, pathPrefix, changes: accountChanges }) =>
      normalizeUnsupportedRealtimeWakeNames(account, pathPrefix, accountChanges),
  });
  updated = accounts.entry;
  changed = changed || accounts.changed;

  const normalizedWakeNames = normalizeUnsupportedRealtimeWakeNames(
    updated,
    "channels.discord",
    changes,
  );
  updated = normalizedWakeNames.entry;
  changed = changed || normalizedWakeNames.changed;

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...tuningKnobs.config,
      channels: {
        ...tuningKnobs.config.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
