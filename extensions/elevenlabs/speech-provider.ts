import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "openclaw/plugin-sdk/speech";
import { elevenLabsTTS } from "./tts.js";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.0,
  useSpeakerBoost: true,
  speed: 1.0,
};

const ELEVENLABS_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

type ElevenLabsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
    speed: number;
  };
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseNumberValue(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

function normalizeElevenLabsBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_ELEVENLABS_BASE_URL;
}

function normalizeElevenLabsProviderConfig(
  rawConfig: Record<string, unknown>,
): ElevenLabsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.elevenlabs) ?? asObject(rawConfig.elevenlabs);
  const rawVoiceSettings = asObject(raw?.voiceSettings);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.elevenlabs.apiKey",
    }),
    baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_ELEVENLABS_MODEL_ID,
    seed: asNumber(raw?.seed),
    applyTextNormalization: trimToUndefined(raw?.applyTextNormalization) as
      | "auto"
      | "on"
      | "off"
      | undefined,
    languageCode: trimToUndefined(raw?.languageCode),
    voiceSettings: {
      stability:
        asNumber(rawVoiceSettings?.stability) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
      similarityBoost:
        asNumber(rawVoiceSettings?.similarityBoost) ??
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
      style: asNumber(rawVoiceSettings?.style) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
      useSpeakerBoost:
        asBoolean(rawVoiceSettings?.useSpeakerBoost) ??
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
      speed: asNumber(rawVoiceSettings?.speed) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
    },
  };
}

function readElevenLabsProviderConfig(config: SpeechProviderConfig): ElevenLabsProviderConfig {
  const defaults = normalizeElevenLabsProviderConfig({});
  const voiceSettings = asObject(config.voiceSettings);
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    seed: asNumber(config.seed) ?? defaults.seed,
    applyTextNormalization:
      (trimToUndefined(config.applyTextNormalization) as "auto" | "on" | "off" | undefined) ??
      defaults.applyTextNormalization,
    languageCode: trimToUndefined(config.languageCode) ?? defaults.languageCode,
    voiceSettings: {
      stability: asNumber(voiceSettings?.stability) ?? defaults.voiceSettings.stability,
      similarityBoost:
        asNumber(voiceSettings?.similarityBoost) ?? defaults.voiceSettings.similarityBoost,
      style: asNumber(voiceSettings?.style) ?? defaults.voiceSettings.style,
      useSpeakerBoost:
        asBoolean(voiceSettings?.useSpeakerBoost) ?? defaults.voiceSettings.useSpeakerBoost,
      speed: asNumber(voiceSettings?.speed) ?? defaults.voiceSettings.speed,
    },
  };
}

function mergeVoiceSettingsOverride(
  ctx: SpeechDirectiveTokenParseContext,
  next: Record<string, unknown>,
): SpeechProviderOverrides {
  return {
    ...(ctx.currentOverrides ?? {}),
    voiceSettings: {
      ...(asObject(ctx.currentOverrides?.voiceSettings) ?? {}),
      ...next,
    },
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  try {
    switch (ctx.key) {
      case "voiceid":
      case "voice_id":
      case "elevenlabs_voice":
      case "elevenlabsvoice":
        if (!ctx.policy.allowVoice) {
          return { handled: true };
        }
        if (!isValidVoiceId(ctx.value)) {
          return { handled: true, warnings: [`invalid ElevenLabs voiceId "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), voiceId: ctx.value },
        };
      case "model":
      case "modelid":
      case "model_id":
      case "elevenlabs_model":
      case "elevenlabsmodel":
        if (!ctx.policy.allowModelId) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: { ...(ctx.currentOverrides ?? {}), modelId: ctx.value },
        };
      case "stability": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid stability value"] };
        }
        requireInRange(value, 0, 1, "stability");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { stability: value }) };
      }
      case "similarity":
      case "similarityboost":
      case "similarity_boost": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid similarityBoost value"] };
        }
        requireInRange(value, 0, 1, "similarityBoost");
        return {
          handled: true,
          overrides: mergeVoiceSettingsOverride(ctx, { similarityBoost: value }),
        };
      }
      case "style": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid style value"] };
        }
        requireInRange(value, 0, 1, "style");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { style: value }) };
      }
      case "speed": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid speed value"] };
        }
        requireInRange(value, 0.5, 2, "speed");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { speed: value }) };
      }
      case "speakerboost":
      case "speaker_boost":
      case "usespeakerboost":
      case "use_speaker_boost": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseBooleanValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid useSpeakerBoost value"] };
        }
        return {
          handled: true,
          overrides: mergeVoiceSettingsOverride(ctx, { useSpeakerBoost: value }),
        };
      }
      case "normalize":
      case "applytextnormalization":
      case "apply_text_normalization":
        if (!ctx.policy.allowNormalization) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...(ctx.currentOverrides ?? {}),
            applyTextNormalization: normalizeApplyTextNormalization(ctx.value),
          },
        };
      case "language":
      case "languagecode":
      case "language_code":
        if (!ctx.policy.allowNormalization) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...(ctx.currentOverrides ?? {}),
            languageCode: normalizeLanguageCode(ctx.value),
          },
        };
      case "seed":
        if (!ctx.policy.allowSeed) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...(ctx.currentOverrides ?? {}),
            seed: normalizeSeed(Number.parseInt(ctx.value, 10)),
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

export async function listElevenLabsVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const res = await fetch(`${normalizeElevenLabsBaseUrl(params.baseUrl)}/v1/voices`, {
    headers: {
      "xi-api-key": params.apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs voices API error (${res.status})`);
  }
  const json = (await res.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      category?: string;
      description?: string;
    }>;
  };
  return Array.isArray(json.voices)
    ? json.voices
        .map((voice) => ({
          id: voice.voice_id?.trim() ?? "",
          name: voice.name?.trim() || undefined,
          category: voice.category?.trim() || undefined,
          description: voice.description?.trim() || undefined,
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function buildElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    autoSelectOrder: 20,
    models: ELEVENLABS_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeElevenLabsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeElevenLabsProviderConfig(baseTtsConfig);
      const talkVoiceSettings = asObject(talkProviderConfig.voiceSettings);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.elevenlabs.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
        ...(asNumber(talkProviderConfig.seed) == null
          ? {}
          : { seed: asNumber(talkProviderConfig.seed) }),
        ...(trimToUndefined(talkProviderConfig.applyTextNormalization) == null
          ? {}
          : {
              applyTextNormalization: normalizeApplyTextNormalization(
                trimToUndefined(talkProviderConfig.applyTextNormalization),
              ),
            }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null
          ? {}
          : {
              languageCode: normalizeLanguageCode(trimToUndefined(talkProviderConfig.languageCode)),
            }),
        voiceSettings: {
          ...base.voiceSettings,
          ...(asNumber(talkVoiceSettings?.stability) == null
            ? {}
            : { stability: asNumber(talkVoiceSettings?.stability) }),
          ...(asNumber(talkVoiceSettings?.similarityBoost) == null
            ? {}
            : { similarityBoost: asNumber(talkVoiceSettings?.similarityBoost) }),
          ...(asNumber(talkVoiceSettings?.style) == null
            ? {}
            : { style: asNumber(talkVoiceSettings?.style) }),
          ...(asBoolean(talkVoiceSettings?.useSpeakerBoost) == null
            ? {}
            : { useSpeakerBoost: asBoolean(talkVoiceSettings?.useSpeakerBoost) }),
          ...(asNumber(talkVoiceSettings?.speed) == null
            ? {}
            : { speed: asNumber(talkVoiceSettings?.speed) }),
        },
      };
    },
    resolveTalkOverrides: ({ params }) => {
      const normalize = trimToUndefined(params.normalize);
      const language = trimToUndefined(params.language)?.toLowerCase();
      const latencyTier = asNumber(params.latencyTier);
      const voiceSettings = {
        ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
        ...(asNumber(params.stability) == null ? {} : { stability: asNumber(params.stability) }),
        ...(asNumber(params.similarity) == null
          ? {}
          : { similarityBoost: asNumber(params.similarity) }),
        ...(asNumber(params.style) == null ? {} : { style: asNumber(params.style) }),
        ...(asBoolean(params.speakerBoost) == null
          ? {}
          : { useSpeakerBoost: asBoolean(params.speakerBoost) }),
      };
      return {
        ...(trimToUndefined(params.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(params.voiceId) }),
        ...(trimToUndefined(params.modelId) == null
          ? {}
          : { modelId: trimToUndefined(params.modelId) }),
        ...(trimToUndefined(params.outputFormat) == null
          ? {}
          : { outputFormat: trimToUndefined(params.outputFormat) }),
        ...(asNumber(params.seed) == null ? {} : { seed: asNumber(params.seed) }),
        ...(normalize == null
          ? {}
          : { applyTextNormalization: normalizeApplyTextNormalization(normalize) }),
        ...(language == null ? {} : { languageCode: normalizeLanguageCode(language) }),
        ...(latencyTier == null ? {} : { latencyTier }),
        ...(Object.keys(voiceSettings).length === 0 ? {} : { voiceSettings }),
      };
    },
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readElevenLabsProviderConfig(req.providerConfig)
        : undefined;
      const apiKey =
        req.apiKey || config?.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      return listElevenLabsVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(
        readElevenLabsProviderConfig(providerConfig).apiKey ||
        process.env.ELEVENLABS_API_KEY ||
        process.env.XI_API_KEY,
      ),
    synthesize: async (req) => {
      const config = readElevenLabsProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const apiKey = config.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat =
        trimToUndefined(overrides.outputFormat) ??
        (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
      const overrideVoiceSettings = asObject(overrides.voiceSettings);
      const latencyTier = asNumber(overrides.latencyTier);
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
        modelId: trimToUndefined(overrides.modelId) ?? config.modelId,
        outputFormat,
        seed: asNumber(overrides.seed) ?? config.seed,
        applyTextNormalization:
          (trimToUndefined(overrides.applyTextNormalization) as
            | "auto"
            | "on"
            | "off"
            | undefined) ?? config.applyTextNormalization,
        languageCode: trimToUndefined(overrides.languageCode) ?? config.languageCode,
        latencyTier,
        voiceSettings: {
          ...config.voiceSettings,
          ...(asNumber(overrideVoiceSettings?.stability) == null
            ? {}
            : { stability: asNumber(overrideVoiceSettings?.stability) }),
          ...(asNumber(overrideVoiceSettings?.similarityBoost) == null
            ? {}
            : { similarityBoost: asNumber(overrideVoiceSettings?.similarityBoost) }),
          ...(asNumber(overrideVoiceSettings?.style) == null
            ? {}
            : { style: asNumber(overrideVoiceSettings?.style) }),
          ...(asBoolean(overrideVoiceSettings?.useSpeakerBoost) == null
            ? {}
            : { useSpeakerBoost: asBoolean(overrideVoiceSettings?.useSpeakerBoost) }),
          ...(asNumber(overrideVoiceSettings?.speed) == null
            ? {}
            : { speed: asNumber(overrideVoiceSettings?.speed) }),
        },
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readElevenLabsProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat = "pcm_22050";
      const sampleRate = 22_050;
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: config.voiceId,
        modelId: config.modelId,
        outputFormat,
        seed: config.seed,
        applyTextNormalization: config.applyTextNormalization,
        languageCode: config.languageCode,
        voiceSettings: config.voiceSettings,
        timeoutMs: req.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
