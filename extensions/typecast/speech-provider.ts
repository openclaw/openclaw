import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { requireInRange } from "openclaw/plugin-sdk/speech-core";
import {
  DEFAULT_TYPECAST_BASE_HOST,
  DEFAULT_TYPECAST_EMOTION_INTENSITY,
  DEFAULT_TYPECAST_EMOTION_PRESET,
  DEFAULT_TYPECAST_MODEL,
  typecastTTS,
} from "./tts.js";

const TYPECAST_TTS_MODELS = ["ssfm-v21", "ssfm-v30"] as const;

const TYPECAST_EMOTION_PRESETS = [
  "normal",
  "happy",
  "sad",
  "angry",
  "whisper",
  "toneup",
  "tonedown",
] as const;

type TypecastProviderConfig = {
  apiKey?: string;
  baseHost: string;
  voiceId?: string;
  model: "ssfm-v21" | "ssfm-v30";
  language?: string;
  emotionPreset: string;
  emotionIntensity: number;
  seed?: number;
  output: {
    volume: number;
    audioPitch: number;
    audioTempo: number;
    audioFormat: "wav" | "mp3";
  };
};

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

function normalizeTypecastBaseHost(baseHost: string | undefined): string {
  const trimmed = baseHost?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_TYPECAST_BASE_HOST;
}

function normalizeTypecastModel(model: unknown): "ssfm-v21" | "ssfm-v30" {
  const trimmed = trimToUndefined(model);
  if (trimmed === "ssfm-v21" || trimmed === "ssfm-v30") {
    return trimmed;
  }
  return DEFAULT_TYPECAST_MODEL;
}

function normalizeTypecastProviderConfig(
  rawConfig: Record<string, unknown>,
): TypecastProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.typecast) ?? asObject(rawConfig.typecast);
  const rawOutput = asObject(raw?.output);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.typecast.apiKey",
    }),
    baseHost: normalizeTypecastBaseHost(trimToUndefined(raw?.baseHost)),
    voiceId: trimToUndefined(raw?.voiceId),
    model: normalizeTypecastModel(raw?.model),
    language: trimToUndefined(raw?.language),
    emotionPreset: trimToUndefined(raw?.emotionPreset) ?? DEFAULT_TYPECAST_EMOTION_PRESET,
    emotionIntensity: asNumber(raw?.emotionIntensity) ?? DEFAULT_TYPECAST_EMOTION_INTENSITY,
    seed: asNumber(raw?.seed),
    output: {
      volume: asNumber(rawOutput?.volume) ?? 100,
      audioPitch: asNumber(rawOutput?.audioPitch) ?? 0,
      audioTempo: asNumber(rawOutput?.audioTempo) ?? 1.0,
      audioFormat: trimToUndefined(rawOutput?.audioFormat) === "wav" ? "wav" : "mp3",
    },
  };
}

function readTypecastProviderConfig(config: SpeechProviderConfig): TypecastProviderConfig {
  const defaults = normalizeTypecastProviderConfig({});
  const rawOutput = asObject(config.output);
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseHost: normalizeTypecastBaseHost(trimToUndefined(config.baseHost) ?? defaults.baseHost),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    model: normalizeTypecastModel(config.model ?? defaults.model),
    language: trimToUndefined(config.language) ?? defaults.language,
    emotionPreset: trimToUndefined(config.emotionPreset) ?? defaults.emotionPreset,
    emotionIntensity: asNumber(config.emotionIntensity) ?? defaults.emotionIntensity,
    seed: asNumber(config.seed) ?? defaults.seed,
    output: {
      volume: asNumber(rawOutput?.volume) ?? defaults.output.volume,
      audioPitch: asNumber(rawOutput?.audioPitch) ?? defaults.output.audioPitch,
      audioTempo: asNumber(rawOutput?.audioTempo) ?? defaults.output.audioTempo,
      audioFormat:
        trimToUndefined(rawOutput?.audioFormat) === "wav" ? "wav" : defaults.output.audioFormat,
    },
  };
}

function parseNumberValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidEmotionPreset(value: string): boolean {
  return (TYPECAST_EMOTION_PRESETS as readonly string[]).includes(value);
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  try {
    switch (ctx.key) {
      case "voice":
      case "voiceid":
      case "voice_id":
      case "typecast_voice":
      case "typecastvoice":
        if (!ctx.policy.allowVoice) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, voiceId: ctx.value },
        };
      case "model":
      case "typecast_model":
      case "typecastmodel":
        if (!ctx.policy.allowModelId) {
          return { handled: true };
        }
        if (ctx.value !== "ssfm-v21" && ctx.value !== "ssfm-v30") {
          return { handled: true, warnings: [`invalid Typecast model "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, model: ctx.value },
        };
      case "emotion":
      case "emotionpreset":
      case "emotion_preset":
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        if (!isValidEmotionPreset(ctx.value)) {
          return { handled: true, warnings: [`invalid emotion preset "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, emotionPreset: ctx.value },
        };
      case "emotionintensity":
      case "emotion_intensity":
      case "intensity": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid emotionIntensity value"] };
        }
        requireInRange(value, 0, 2, "emotionIntensity");
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, emotionIntensity: value },
        };
      }
      case "language":
      case "lang":
        if (!ctx.policy.allowNormalization) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, language: ctx.value },
        };
      case "seed":
        if (!ctx.policy.allowSeed) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...ctx.currentOverrides,
            seed: Number.parseInt(ctx.value, 10),
          },
        };
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

/** Parse sample rate from a WAV header (bytes 24–27, little-endian uint32). */
function parseWavSampleRate(buf: Buffer, fallback = 24000): number {
  if (
    buf.length >= 28 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  ) {
    return buf.readUInt32LE(24);
  }
  return fallback;
}

export function buildTypecastSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "typecast",
    label: "Typecast",
    autoSelectOrder: 15,
    models: TYPECAST_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeTypecastProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeTypecastProviderConfig(baseTtsConfig);
      const rawOutput = asObject(talkProviderConfig.output);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.typecast.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseHost) == null
          ? {}
          : { baseHost: normalizeTypecastBaseHost(trimToUndefined(talkProviderConfig.baseHost)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.model) == null
          ? {}
          : { model: normalizeTypecastModel(talkProviderConfig.model) }),
        ...(trimToUndefined(talkProviderConfig.language) == null
          ? {}
          : { language: trimToUndefined(talkProviderConfig.language) }),
        ...(trimToUndefined(talkProviderConfig.emotionPreset) == null
          ? {}
          : { emotionPreset: trimToUndefined(talkProviderConfig.emotionPreset) }),
        ...(asNumber(talkProviderConfig.emotionIntensity) == null
          ? {}
          : { emotionIntensity: asNumber(talkProviderConfig.emotionIntensity) }),
        ...(asNumber(talkProviderConfig.seed) == null
          ? {}
          : { seed: asNumber(talkProviderConfig.seed) }),
        output: {
          ...base.output,
          ...(asNumber(rawOutput?.volume) == null ? {} : { volume: asNumber(rawOutput?.volume) }),
          ...(asNumber(rawOutput?.audioPitch) == null
            ? {}
            : { audioPitch: asNumber(rawOutput?.audioPitch) }),
          ...(asNumber(rawOutput?.audioTempo) == null
            ? {}
            : { audioTempo: asNumber(rawOutput?.audioTempo) }),
          ...(trimToUndefined(rawOutput?.audioFormat) == null
            ? {}
            : {
                audioFormat:
                  trimToUndefined(rawOutput?.audioFormat) === "wav"
                    ? ("wav" as const)
                    : ("mp3" as const),
              }),
        },
      };
    },
    resolveTalkOverrides: ({ params }) => {
      const output = {
        ...(asNumber(params.volume) == null ? {} : { volume: asNumber(params.volume) }),
        ...(asNumber(params.audioPitch) == null ? {} : { audioPitch: asNumber(params.audioPitch) }),
        ...(asNumber(params.audioTempo) == null ? {} : { audioTempo: asNumber(params.audioTempo) }),
      };
      return {
        ...(trimToUndefined(params.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(params.voiceId) }),
        ...(trimToUndefined(params.model) == null ? {} : { model: trimToUndefined(params.model) }),
        ...(trimToUndefined(params.emotionPreset) == null
          ? {}
          : { emotionPreset: trimToUndefined(params.emotionPreset) }),
        ...(asNumber(params.emotionIntensity) == null
          ? {}
          : { emotionIntensity: asNumber(params.emotionIntensity) }),
        ...(trimToUndefined(params.language) == null
          ? {}
          : { language: trimToUndefined(params.language) }),
        ...(asNumber(params.seed) == null ? {} : { seed: asNumber(params.seed) }),
        ...(Object.keys(output).length === 0 ? {} : { output }),
      };
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(readTypecastProviderConfig(providerConfig).apiKey || process.env.TYPECAST_API_KEY),
    synthesize: async (req) => {
      const config = readTypecastProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const apiKey = config.apiKey || process.env.TYPECAST_API_KEY;
      if (!apiKey) {
        throw new Error("Typecast API key missing");
      }
      const audioFormat =
        trimToUndefined(overrides.audioFormat) === "wav"
          ? ("wav" as const)
          : config.output.audioFormat;
      const rawOverrideOutput = asObject(overrides.output);
      const audioBuffer = await typecastTTS({
        text: req.text,
        apiKey,
        baseHost: config.baseHost,
        voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
        model: normalizeTypecastModel(overrides.model ?? config.model),
        language: trimToUndefined(overrides.language) ?? config.language,
        emotionPreset: trimToUndefined(overrides.emotionPreset) ?? config.emotionPreset,
        emotionIntensity: asNumber(overrides.emotionIntensity) ?? config.emotionIntensity,
        seed: asNumber(overrides.seed) ?? config.seed,
        output: {
          volume: asNumber(rawOverrideOutput?.volume) ?? config.output.volume,
          audioPitch: asNumber(rawOverrideOutput?.audioPitch) ?? config.output.audioPitch,
          audioTempo: asNumber(rawOverrideOutput?.audioTempo) ?? config.output.audioTempo,
          audioFormat,
        },
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: audioFormat,
        fileExtension: audioFormat === "wav" ? ".wav" : ".mp3",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readTypecastProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.TYPECAST_API_KEY;
      if (!apiKey) {
        throw new Error("Typecast API key missing");
      }
      const audioBuffer = await typecastTTS({
        text: req.text,
        apiKey,
        baseHost: config.baseHost,
        voiceId: config.voiceId,
        model: config.model,
        language: config.language,
        emotionPreset: config.emotionPreset,
        emotionIntensity: config.emotionIntensity,
        seed: config.seed,
        output: {
          volume: config.output.volume,
          audioPitch: config.output.audioPitch,
          audioTempo: config.output.audioTempo,
          audioFormat: "wav",
        },
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "wav",
        sampleRate: parseWavSampleRate(audioBuffer),
      };
    },
  };
}
