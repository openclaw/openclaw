/**
 * Configuration types + normalization for the Adaptive Tone plugin.
 *
 * The authoritative JSON Schema lives in `openclaw.plugin.json` (manifest
 * `configSchema`), which is what OpenClaw uses for validation and the settings
 * UI. This module mirrors that shape in TypeScript and fills in defaults so the
 * runtime logic always works with a fully-populated, typed config object.
 */

import type { ToneState } from "./states.js";

export type ChannelRegister = "professional" | "casual" | "neutral";

export interface AdaptiveToneConfig {
  /** Master switch. When false the plugin injects nothing. */
  enabled: boolean;
  time: {
    enabled: boolean;
    /**
     * IANA timezone (e.g. "Europe/Berlin") used to bucket the hour of day.
     * The `before_prompt_build` hook context does not currently expose the
     * user's timezone, so this is the operator-controlled source of truth.
     * When omitted, the Gateway host's local time is used.
     */
    timezone?: string;
  };
  place: {
    enabled: boolean;
    /** Channel ids/prefixes that should get a professional register. */
    professionalChannels: string[];
    /** Channel ids/prefixes that should get a casual register. */
    casualChannels: string[];
  };
  repetition: {
    enabled: boolean;
    /** How many recent user turns to scan for repeated asks. */
    windowTurns: number;
    /** Token-overlap (Jaccard) threshold above which two asks count as the same. */
    similarityThreshold: number;
  };
  wellbeing: {
    enabled: boolean;
    /** Lower-cased phrases that, if present in the user message, flag distress. */
    phrases: string[];
  };
  weather: {
    enabled: boolean;
    latitude: number;
    longitude: number;
  };
  /** Optional per-state overrides of the injected guidance text. */
  guidanceOverrides: Partial<Record<ToneState, string>>;
}

export const DEFAULT_PROFESSIONAL_CHANNELS = [
  "slack",
  "teams",
  "msteams",
  "googlechat",
  "mattermost",
  "feishu",
];

export const DEFAULT_CASUAL_CHANNELS = [
  "whatsapp",
  "imessage",
  "telegram",
  "discord",
  "signal",
  "line",
];

export const DEFAULT_WELLBEING_PHRASES = [
  "i'm not well",
  "i am not well",
  "i'm sick",
  "i am sick",
  "i feel sick",
  "feeling unwell",
  "not feeling well",
  "feeling awful",
  "feeling terrible",
  "i'm exhausted",
  "i am exhausted",
  "i'm so tired",
  "rough day",
  "bad day",
  "i'm in pain",
  "feeling down",
  "feeling low",
];

const DEFAULTS: AdaptiveToneConfig = {
  enabled: true,
  time: { enabled: true },
  place: {
    enabled: true,
    professionalChannels: DEFAULT_PROFESSIONAL_CHANNELS,
    casualChannels: DEFAULT_CASUAL_CHANNELS,
  },
  repetition: { enabled: true, windowTurns: 6, similarityThreshold: 0.8 },
  wellbeing: { enabled: true, phrases: DEFAULT_WELLBEING_PHRASES },
  weather: { enabled: true, latitude: 52.52, longitude: 13.41 },
  guidanceOverrides: {},
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Merge raw plugin config (untyped, possibly partial) onto safe defaults.
 * Never throws: any malformed field falls back to its default.
 */
export function normalizeConfig(raw: unknown): AdaptiveToneConfig {
  const root = asObject(raw);
  const time = asObject(root.time);
  const place = asObject(root.place);
  const repetition = asObject(root.repetition);
  const wellbeing = asObject(root.wellbeing);
  const weather = asObject(root.weather);
  const overrides = asObject(root.guidanceOverrides);

  return {
    enabled: asBool(root.enabled, DEFAULTS.enabled),
    time: {
      enabled: asBool(time.enabled, DEFAULTS.time.enabled),
      timezone: typeof time.timezone === "string" ? time.timezone : undefined,
    },
    place: {
      enabled: asBool(place.enabled, DEFAULTS.place.enabled),
      professionalChannels: asStringArray(
        place.professionalChannels,
        DEFAULTS.place.professionalChannels,
      ).map((s) => s.toLowerCase()),
      casualChannels: asStringArray(place.casualChannels, DEFAULTS.place.casualChannels).map((s) =>
        s.toLowerCase(),
      ),
    },
    repetition: {
      enabled: asBool(repetition.enabled, DEFAULTS.repetition.enabled),
      windowTurns: asInt(repetition.windowTurns, DEFAULTS.repetition.windowTurns, 1, 20),
      similarityThreshold: asNumber(
        repetition.similarityThreshold,
        DEFAULTS.repetition.similarityThreshold,
        0.1,
        1,
      ),
    },
    wellbeing: {
      enabled: asBool(wellbeing.enabled, DEFAULTS.wellbeing.enabled),
      phrases: asStringArray(wellbeing.phrases, DEFAULTS.wellbeing.phrases).map((s) =>
        s.toLowerCase(),
      ),
    },
    weather: {
      enabled: asBool(weather.enabled, DEFAULTS.weather.enabled),
      latitude: asNumber(weather.latitude, DEFAULTS.weather.latitude, -90, 90),
      longitude: asNumber(weather.longitude, DEFAULTS.weather.longitude, -180, 180),
    },
    guidanceOverrides: Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => typeof v === "string"),
    ) as Partial<Record<ToneState, string>>,
  };
}
