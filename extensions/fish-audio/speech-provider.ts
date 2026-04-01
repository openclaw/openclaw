import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";
import { requireInRange } from "openclaw/plugin-sdk/speech-core";
import {
  DEFAULT_FISH_AUDIO_BASE_URL,
  fishAudioTTS,
  listFishAudioVoices,
  normalizeFishAudioBaseUrl,
} from "./tts.js";

// ── Defaults ────────────────────────────────────────────────────────────────
// No default voice — users must configure one. Fish Audio has no universal
// "default" voice like ElevenLabs does, and shipping a personal clone ID
// as default would be wrong for community users.
const DEFAULT_VOICE_ID = "";
const DEFAULT_MODEL = "s2-pro";
const DEFAULT_LATENCY = "normal" as const;

const FISH_AUDIO_MODELS = ["s2-pro", "s1"] as const;

// ── Types ───────────────────────────────────────────────────────────────────

type FishAudioProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  model: string;
  latency: "normal" | "balanced" | "low";
  speed?: number;
  temperature?: number;
  topP?: number;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseNumberValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeLatency(value: unknown): "normal" | "balanced" | "low" {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "balanced" || s === "low") return s;
  return DEFAULT_LATENCY;
}

function normalizeModel(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s || DEFAULT_MODEL;
}

/** Fish Audio voice ref IDs — alphanumeric, 20-64 chars. Permissive enough
 *  to handle future ID format changes while still rejecting path traversal
 *  and injection attempts. */
export function isValidFishAudioVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{20,64}$/.test(voiceId);
}

// ── Config resolution ───────────────────────────────────────────────────────

function normalizeFishAudioProviderConfig(
  rawConfig: Record<string, unknown>,
): FishAudioProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.["fish-audio"]) ?? asObject(rawConfig["fish-audio"]);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.fish-audio.apiKey",
    }),
    baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_VOICE_ID,
    model: normalizeModel(raw?.model),
    latency: normalizeLatency(raw?.latency),
    speed: asNumber(raw?.speed),
    temperature: asNumber(raw?.temperature),
    topP: asNumber(raw?.topP),
  };
}

function readFishAudioProviderConfig(config: SpeechProviderConfig): FishAudioProviderConfig {
  const defaults = normalizeFishAudioProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    model: normalizeModel(config.model) || defaults.model,
    latency: normalizeLatency(config.latency),
    speed: asNumber(config.speed) ?? defaults.speed,
    temperature: asNumber(config.temperature) ?? defaults.temperature,
    topP: asNumber(config.topP) ?? defaults.topP,
  };
}

// ── Directive parsing ───────────────────────────────────────────────────────

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  // Only claim provider-prefixed keys to avoid dispatch collisions.
  // `parseTtsDirectives` stops at the first provider whose `parseDirectiveToken`
  // returns `handled: true`, and bundled providers with lower `autoSelectOrder`
  // (e.g. OpenAI at 10) are visited first. Generic keys like "voice" or "model"
  // would be swallowed by earlier providers and never reach us.
  // Convention matches ElevenLabs: `elevenlabs_voice`, `elevenlabs_model`, etc.
  try {
    switch (ctx.key) {
      case "fishaudio_voice":
      case "fish_voice":
      case "fishaudio_voiceid":
        if (!ctx.policy.allowVoice) {
          return { handled: true };
        }
        if (!isValidFishAudioVoiceId(ctx.value)) {
          return {
            handled: true,
            warnings: [`invalid Fish Audio voice ID "${ctx.value}"`],
          };
        }
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), voiceId: ctx.value },
        };

      case "fishaudio_model":
      case "fish_model":
        if (!ctx.policy.allowModelId) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), model: ctx.value },
        };

      case "fishaudio_speed":
      case "fish_speed": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid speed value"] };
        }
        requireInRange(value, 0.5, 2.0, "speed");
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), speed: value },
        };
      }

      case "fishaudio_latency":
      case "fish_latency": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const raw = typeof ctx.value === "string" ? ctx.value.trim().toLowerCase() : "";
        if (raw !== "normal" && raw !== "balanced" && raw !== "low") {
          return {
            handled: true,
            warnings: [
              `invalid Fish Audio latency "${ctx.value}" (expected: normal, balanced, low)`,
            ],
          };
        }
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), latency: raw },
        };
      }

      case "fishaudio_temperature":
      case "fish_temperature": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid temperature value"] };
        }
        requireInRange(value, 0, 1, "temperature");
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), temperature: value },
        };
      }

      case "fishaudio_top_p":
      case "fish_top_p": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid top_p value"] };
        }
        requireInRange(value, 0, 1, "top_p");
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), topP: value },
        };
      }

      default:
        return { handled: false };
    }
  } catch (error) {
    return {
      handled: true,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export function buildFishAudioSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "fish-audio",
    label: "Fish Audio",
    // Lower = higher priority in auto-detect fallback. Positioned below OpenAI (10)
    // but above ElevenLabs (20) and Microsoft (30) since Fish Audio requires
    // explicit configuration (apiKey + voiceId) to pass isConfigured().
    autoSelectOrder: 15,
    models: FISH_AUDIO_MODELS,

    resolveConfig: ({ rawConfig }) => normalizeFishAudioProviderConfig(rawConfig),

    parseDirectiveToken,

    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeFishAudioProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.fish-audio.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: normalizeModel(talkProviderConfig.modelId) }),
        ...(talkProviderConfig.latency == null
          ? {}
          : { latency: normalizeLatency(talkProviderConfig.latency) }),
        ...(asNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asNumber(talkProviderConfig.speed) }),
        ...(asNumber(talkProviderConfig.temperature) == null
          ? {}
          : { temperature: asNumber(talkProviderConfig.temperature) }),
        ...(asNumber(talkProviderConfig.topP) == null
          ? {}
          : { topP: asNumber(talkProviderConfig.topP) }),
      };
    },

    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
    }),

    listVoices: async (req) => {
      const config = req.providerConfig
        ? readFishAudioProviderConfig(req.providerConfig)
        : undefined;
      const apiKey = req.apiKey || config?.apiKey || process.env.FISH_AUDIO_API_KEY;
      if (!apiKey) {
        throw new Error("Fish Audio API key missing");
      }
      const raw = await listFishAudioVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
      });
      return raw as SpeechVoiceOption[];
    },

    isConfigured: ({ providerConfig }) => {
      const config = readFishAudioProviderConfig(providerConfig);
      const hasKey = Boolean(config.apiKey || process.env.FISH_AUDIO_API_KEY);
      const hasVoice = Boolean(config.voiceId);
      return hasKey && hasVoice;
    },

    synthesize: async (req) => {
      const config = readFishAudioProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const apiKey = config.apiKey || process.env.FISH_AUDIO_API_KEY;
      if (!apiKey) {
        throw new Error("Fish Audio API key missing");
      }

      const voiceId = trimToUndefined(overrides.voiceId) ?? config.voiceId;
      if (!voiceId) {
        throw new Error(
          "Fish Audio: no voiceId configured. Set messages.tts.providers.fish-audio.voiceId",
        );
      }

      // Pick format based on target channel
      const useOpus = req.target === "voice-note";
      const format = useOpus ? "opus" : "mp3";

      const speed = asNumber(overrides.speed) ?? config.speed;
      if (speed != null) {
        requireInRange(speed, 0.5, 2.0, "speed");
      }

      const audioBuffer = await fishAudioTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        referenceId: voiceId,
        model: trimToUndefined(overrides.model) ?? config.model,
        format,
        latency: overrides.latency != null ? normalizeLatency(overrides.latency) : config.latency,
        speed,
        temperature: asNumber(overrides.temperature) ?? config.temperature,
        topP: asNumber(overrides.topP) ?? config.topP,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: format,
        fileExtension: useOpus ? ".opus" : ".mp3",
        voiceCompatible: useOpus, // Only voice-note targets (Telegram, WhatsApp, etc.) get voice-compatible output
      };
    },
  };
}
