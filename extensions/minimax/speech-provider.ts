import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { asObject, requireInRange, trimToUndefined } from "openclaw/plugin-sdk/speech";
import {
  DEFAULT_MINIMAX_TTS_BASE_URL,
  MINIMAX_TTS_EMOTIONS,
  MINIMAX_TTS_MODELS,
  MINIMAX_TTS_VOICES,
  minimaxTTS,
  normalizeMinimaxTtsBaseUrl,
} from "./tts.js";

type MinimaxTtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  emotion?: string;
  languageBoost?: string;
};

type MinimaxTtsProviderOverrides = {
  model?: string;
  voiceId?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
};

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMinimaxProviderConfig(
  rawConfig: Record<string, unknown>,
): MinimaxTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.minimax) ?? asObject(rawConfig.minimax);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.minimax.apiKey",
    }),
    baseUrl: normalizeMinimaxTtsBaseUrl(trimToUndefined(raw?.baseUrl)),
    model: trimToUndefined(raw?.model) ?? "speech-2.8-hd",
    voiceId: trimToUndefined(raw?.voiceId) ?? "English_expressive_narrator",
    speed: asNumber(raw?.speed) ?? 1,
    vol: asNumber(raw?.vol) ?? 1,
    pitch: asNumber(raw?.pitch) ?? 0,
    emotion: trimToUndefined(raw?.emotion),
    languageBoost: trimToUndefined(raw?.languageBoost),
  };
}

function readMinimaxProviderConfig(config: SpeechProviderConfig): MinimaxTtsProviderConfig {
  const defaults = normalizeMinimaxProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeMinimaxTtsBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    model: trimToUndefined(config.model) ?? defaults.model,
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    speed: asNumber(config.speed) ?? defaults.speed,
    vol: asNumber(config.vol) ?? defaults.vol,
    pitch: asNumber(config.pitch) ?? defaults.pitch,
    emotion: trimToUndefined(config.emotion) ?? defaults.emotion,
    languageBoost: trimToUndefined(config.languageBoost) ?? defaults.languageBoost,
  };
}

function readMinimaxOverrides(
  overrides: SpeechProviderOverrides | undefined,
): MinimaxTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    voiceId: trimToUndefined(overrides.voiceId),
    speed: asNumber(overrides.speed),
    vol: asNumber(overrides.vol),
    pitch: asNumber(overrides.pitch),
    emotion: trimToUndefined(overrides.emotion),
  };
}

function isValidMinimaxEmotion(emotion: string): boolean {
  return (MINIMAX_TTS_EMOTIONS as readonly string[]).includes(emotion);
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  try {
    switch (ctx.key) {
      case "voice":
      case "voice_id":
      case "voiceid":
      case "minimax_voice":
      case "minimaxvoice":
        if (!ctx.policy.allowVoice) {
          return { handled: true };
        }
        return { handled: true, overrides: { voiceId: ctx.value } };

      case "model":
      case "minimax_model":
      case "minimaxmodel":
        if (!ctx.policy.allowModelId) {
          return { handled: true };
        }
        return { handled: true, overrides: { model: ctx.value } };

      case "minimax_speed":
      case "minimaxspeed": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = Number.parseInt(ctx.value, 10);
        if (!Number.isFinite(value)) {
          return { handled: true, warnings: ["invalid speed value"] };
        }
        requireInRange(value, 1, 2, "speed");
        return { handled: true, overrides: { speed: value } };
      }

      case "vol":
      case "volume":
      case "minimax_vol":
      case "minimaxvol": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = Number.parseInt(ctx.value, 10);
        if (!Number.isFinite(value)) {
          return { handled: true, warnings: ["invalid vol value"] };
        }
        requireInRange(value, 1, 10, "vol");
        return { handled: true, overrides: { vol: value } };
      }

      case "pitch":
      case "minimax_pitch":
      case "minimaxpitch": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = Number.parseInt(ctx.value, 10);
        if (!Number.isFinite(value)) {
          return { handled: true, warnings: ["invalid pitch value"] };
        }
        requireInRange(value, -12, 12, "pitch");
        return { handled: true, overrides: { pitch: value } };
      }

      case "emotion":
      case "minimax_emotion":
      case "minimaxemotion": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        if (!isValidMinimaxEmotion(ctx.value)) {
          return { handled: true, warnings: [`invalid MiniMax emotion "${ctx.value}"`] };
        }
        return { handled: true, overrides: { emotion: ctx.value } };
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

export function buildMinimaxSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    aliases: ["minimax-tts"],
    autoSelectOrder: 30,
    models: MINIMAX_TTS_MODELS,
    voices: MINIMAX_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeMinimaxProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMinimaxProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.minimax.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeMinimaxTtsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asNumber(talkProviderConfig.speed) }),
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
    listVoices: async () =>
      MINIMAX_TTS_VOICES.map((voice) => ({ id: voice, name: voice.replace(/_/g, " ") })),
    isConfigured: ({ providerConfig }) =>
      Boolean(
        readMinimaxProviderConfig(providerConfig).apiKey ||
        process.env.MINIMAX_API_KEY ||
        process.env.MINIMAX_CODE_PLAN_KEY,
      ),
    synthesize: async (req) => {
      const config = readMinimaxProviderConfig(req.providerConfig);
      const overrides = readMinimaxOverrides(req.providerOverrides);
      const apiKey =
        config.apiKey || process.env.MINIMAX_API_KEY || process.env.MINIMAX_CODE_PLAN_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voiceId: overrides.voiceId ?? config.voiceId,
        speed: overrides.speed ?? config.speed,
        vol: overrides.vol ?? config.vol,
        pitch: overrides.pitch ?? config.pitch,
        emotion: overrides.emotion ?? config.emotion,
        languageBoost: config.languageBoost,
        audioFormat: "mp3",
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
  };
}
