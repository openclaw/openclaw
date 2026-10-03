import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  parseSpeechDirectiveNumberOverride,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_INWORLD_MODEL_ID,
  DEFAULT_INWORLD_VOICE_ID,
  type InworldAudioEncoding,
  INWORLD_TTS_MODELS,
  inworldTTS,
  listInworldVoices,
  normalizeInworldBaseUrl,
} from "./tts.js";

type InworldProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  temperature?: number;
};

type InworldSynthesisRequest = {
  text: string;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
  audioEncoding: InworldAudioEncoding;
  sampleRateHertz?: number;
};

function normalizeInworldTemperature(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0, minExclusive: true, max: 2 });
}

function normalizeInworldProviderConfig(rawConfig: Record<string, unknown>): InworldProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.inworld) ?? asOptionalRecord(rawConfig.inworld);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.inworld.apiKey",
    }),
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_INWORLD_VOICE_ID,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_INWORLD_MODEL_ID,
    temperature: normalizeInworldTemperature(raw?.temperature),
  };
}

function readInworldProviderConfig(config: SpeechProviderConfig): InworldProviderConfig {
  return normalizeInworldProviderConfig({
    inworld: { ...config, apiKey: trimToUndefined(config.apiKey) },
  });
}

function resolveInworldApiKey(primary?: string, fallback?: string): string | undefined {
  return resolveSpeechProviderApiKey(primary, fallback, process.env.INWORLD_API_KEY);
}

async function synthesizeInworld(req: InworldSynthesisRequest): Promise<Buffer> {
  const config = readInworldProviderConfig(req.providerConfig);
  const overrides = req.providerOverrides;
  const apiKey = resolveInworldApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Inworld API key missing");
  }

  return inworldTTS({
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: trimToUndefined(overrides?.voiceId ?? overrides?.voice) ?? config.voiceId,
    modelId: trimToUndefined(overrides?.modelId ?? overrides?.model) ?? config.modelId,
    audioEncoding: req.audioEncoding,
    ...(req.sampleRateHertz === undefined ? {} : { sampleRateHertz: req.sampleRateHertz }),
    temperature: normalizeInworldTemperature(overrides?.temperature) ?? config.temperature,
    timeoutMs: req.timeoutMs,
  });
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  if (ctx.key === "temperature") {
    return parseSpeechDirectiveNumberOverride({
      ctx,
      overrideKey: "temperature",
      range: { min: 0, minExclusive: true, max: 2 },
      warning: (value) => `invalid Inworld temperature "${value}"`,
    });
  }
  const key = ["voice", "voiceid", "voice_id", "inworld_voice", "inworldvoice"].includes(ctx.key)
    ? "voiceId"
    : ["model", "modelid", "model_id", "inworld_model", "inworldmodel"].includes(ctx.key)
      ? "modelId"
      : undefined;
  if (!key) {
    return { handled: false };
  }
  return (key === "voiceId" ? ctx.policy.allowVoice : ctx.policy.allowModelId)
    ? { handled: true, overrides: { [key]: ctx.value } }
    : { handled: true };
}

export function buildInworldSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "inworld",
    label: "Inworld",
    autoSelectOrder: 30,
    defaultModel: DEFAULT_INWORLD_MODEL_ID,
    models: INWORLD_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeInworldProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeInworldProviderConfig(baseTtsConfig);
      const resolvedApiKey =
        talkProviderConfig.apiKey === undefined
          ? undefined
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.inworld.apiKey",
            });
      return {
        ...base,
        ...filterStringRecord({
          apiKey: resolvedApiKey,
          baseUrl: trimToUndefined(talkProviderConfig.baseUrl)
            ? normalizeInworldBaseUrl(trimToUndefined(talkProviderConfig.baseUrl))
            : undefined,
          voiceId: trimToUndefined(talkProviderConfig.voiceId),
          modelId: trimToUndefined(talkProviderConfig.modelId),
        }),
        ...(normalizeInworldTemperature(talkProviderConfig.temperature) == null
          ? {}
          : { temperature: normalizeInworldTemperature(talkProviderConfig.temperature) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...filterStringRecord({
        voiceId: trimToUndefined(params.voiceId),
        modelId: trimToUndefined(params.modelId),
      }),
      ...(normalizeInworldTemperature(params.temperature) == null
        ? {}
        : { temperature: normalizeInworldTemperature(params.temperature) }),
    }),
    listVoices: async (req) => {
      const config = req.providerConfig ? readInworldProviderConfig(req.providerConfig) : undefined;
      const apiKey = resolveInworldApiKey(req.apiKey, config?.apiKey);
      if (!apiKey) {
        throw new Error("Inworld API key missing");
      }
      return listInworldVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
        timeoutMs: req.timeoutMs,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveInworldApiKey(readInworldProviderConfig(providerConfig).apiKey)),
    synthesize: async (req) => {
      const useOpus = req.target === "voice-note";
      const audioEncoding: InworldAudioEncoding = useOpus ? "OGG_OPUS" : "MP3";
      const audioBuffer = await synthesizeInworld({
        ...req,
        audioEncoding,
      });

      return {
        audioBuffer,
        outputFormat: audioEncoding.toLowerCase(),
        fileExtension: useOpus ? ".ogg" : ".mp3",
        voiceCompatible: useOpus,
      };
    },
    synthesizeTelephony: async (req) => {
      const sampleRate = 22_050;
      const audioBuffer = await synthesizeInworld({
        ...req,
        audioEncoding: "PCM",
        sampleRateHertz: sampleRate,
      });

      return { audioBuffer, outputFormat: "pcm", sampleRate };
    },
  };
}
