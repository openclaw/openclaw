import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asNullableRecord,
  normalizeOptionalLowercaseString as normalizeProviderId,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

function hasLegacyGoogleRealtimeProvider(value: unknown): boolean {
  const realtime = asNullableRecord(value);
  if (!realtime || normalizeProviderId(realtime.provider) !== "google") {
    return false;
  }
  return (
    !Object.hasOwn(realtime, "voiceProvider") || !Object.hasOwn(realtime, "transcriptionProvider")
  );
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "google-meet", "config", "realtime"],
    message:
      'plugins.entries.google-meet.config.realtime.provider="google" is legacy for Gemini Live bidi mode; use realtime.voiceProvider="google" and realtime.transcriptionProvider="openai". Run "openclaw doctor --fix".',
    match: hasLegacyGoogleRealtimeProvider,
  },
];

export function normalizeCompatibilityConfig({ cfg: config }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asNullableRecord(config.plugins?.entries?.["google-meet"]);
  const rawPluginConfig = asNullableRecord(rawEntry?.config);
  const rawRealtime = asNullableRecord(rawPluginConfig?.realtime);
  if (!rawRealtime || !hasLegacyGoogleRealtimeProvider(rawRealtime)) {
    return { config, changes: [] };
  }

  const nextRealtime: Record<string, unknown> = { ...rawRealtime, provider: "openai" };
  if (!Object.hasOwn(nextRealtime, "transcriptionProvider")) {
    nextRealtime.transcriptionProvider = "openai";
  }
  if (!Object.hasOwn(nextRealtime, "voiceProvider")) {
    nextRealtime.voiceProvider = "google";
  }

  return {
    config: {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          "google-meet": { ...rawEntry, config: { ...rawPluginConfig, realtime: nextRealtime } },
        },
      },
    },
    changes: [
      'Moved Google Meet legacy realtime.provider="google" intent to realtime.voiceProvider="google" and realtime.transcriptionProvider="openai".',
    ],
  };
}
