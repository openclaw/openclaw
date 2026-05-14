import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  DEFAULT_SENSEAUDIO_TTS_BASE_URL,
  DEFAULT_SENSEAUDIO_TTS_MODEL,
  DEFAULT_SENSEAUDIO_TTS_VOICE,
  listSenseAudioSystemVoices,
  normalizeSenseAudioTtsBaseUrl,
  senseAudioTTS,
} from "./tts.js";

const SENSEAUDIO_TTS_MODELS = [DEFAULT_SENSEAUDIO_TTS_MODEL] as const;
const SENSEAUDIO_LIST_VOICES_TIMEOUT_MS = 15_000;

type SenseAudioSpeechConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
};

type SenseAudioSpeechOverrides = {
  voiceId?: string;
  modelId?: string;
};

function resolveSenseAudioConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.senseaudio) ?? asObject(rawConfig.senseaudio);
}

function normalizeSenseAudioProviderConfig(
  rawConfig: Record<string, unknown>,
): SenseAudioSpeechConfig {
  const raw = resolveSenseAudioConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.senseaudio.apiKey",
    }),
    baseUrl: normalizeSenseAudioTtsBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_SENSEAUDIO_TTS_VOICE,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_SENSEAUDIO_TTS_MODEL,
  };
}

function readSenseAudioProviderConfig(config: SpeechProviderConfig): SenseAudioSpeechConfig {
  const defaults = normalizeSenseAudioProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeSenseAudioTtsBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
  };
}

function readSenseAudioOverrides(
  overrides: SpeechProviderOverrides | undefined,
): SenseAudioSpeechOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: trimToUndefined(overrides.voiceId),
    modelId: trimToUndefined(overrides.modelId),
  };
}

function resolveSenseAudioApiKey(config: SenseAudioSpeechConfig): string | undefined {
  return config.apiKey ?? trimToUndefined(process.env.SENSEAUDIO_API_KEY);
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
): SpeechDirectiveTokenParseResult {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "senseaudio_voice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, voiceId: ctx.value } };
    case "model":
    case "modelid":
    case "model_id":
    case "senseaudio_model":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, modelId: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildSenseAudioSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "senseaudio",
    label: "SenseAudio",
    autoSelectOrder: 45,
    models: SENSEAUDIO_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeSenseAudioProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeSenseAudioProviderConfig(baseTtsConfig);
      const apiKey =
        talkProviderConfig.apiKey === undefined
          ? undefined
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.senseaudio.apiKey",
            });
      return {
        ...base,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : {
              baseUrl: normalizeSenseAudioTtsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)),
            }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { modelId: trimToUndefined(params.modelId) }),
    }),
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readSenseAudioProviderConfig(req.providerConfig)
        : undefined;
      const apiKey =
        trimToUndefined(req.apiKey) ?? (config ? resolveSenseAudioApiKey(config) : undefined);
      if (!apiKey) {
        throw new Error("SenseAudio API key missing");
      }
      return await listSenseAudioSystemVoices({
        apiKey,
        baseUrl: trimToUndefined(req.baseUrl) ?? config?.baseUrl ?? DEFAULT_SENSEAUDIO_TTS_BASE_URL,
        timeoutMs: SENSEAUDIO_LIST_VOICES_TIMEOUT_MS,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveSenseAudioApiKey(readSenseAudioProviderConfig(providerConfig))),
    synthesize: async (req) => {
      const config = readSenseAudioProviderConfig(req.providerConfig);
      const overrides = readSenseAudioOverrides(req.providerOverrides);
      const apiKey = resolveSenseAudioApiKey(config);
      if (!apiKey) {
        throw new Error("SenseAudio API key missing");
      }
      const audioBuffer = await senseAudioTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.modelId ?? config.modelId,
        voiceId: overrides.voiceId ?? config.voiceId,
        timeoutMs: req.timeoutMs,
      });
      if (req.target === "voice-note") {
        const opusBuffer = await transcodeAudioBufferToOpus({
          audioBuffer,
          inputExtension: "mp3",
          tempPrefix: "tts-senseaudio-",
          timeoutMs: req.timeoutMs,
        });
        return {
          audioBuffer: opusBuffer,
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
