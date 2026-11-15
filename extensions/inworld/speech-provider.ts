import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  createSpeechDirectiveParser,
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
  INWORLD_DELIVERY_MODES,
  type InworldAudioEncoding,
  type InworldDeliveryMode,
  INWORLD_TTS_MODELS,
  inworldTTS,
  listInworldVoices,
  normalizeInworldBaseUrl,
} from "./tts.js";

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

// Inworld accepts audioConfig.speakingRate between 0.5 and 1.5 (1.0 = native speed).
const INWORLD_SPEAKING_RATE_RANGE = { min: 0.5, max: 1.5 } as const;

function normalizeInworldSpeakingRate(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, INWORLD_SPEAKING_RATE_RANGE);
}

function normalizeInworldDeliveryMode(value: unknown): InworldDeliveryMode | undefined {
  const normalized = trimToUndefined(value)?.toUpperCase();
  return INWORLD_DELIVERY_MODES.find((mode) => mode === normalized);
}

function normalizeInworldProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.inworld);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.inworld.apiKey",
    }),
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_INWORLD_VOICE_ID,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_INWORLD_MODEL_ID,
    temperature: normalizeInworldTemperature(raw?.temperature),
    speakingRate: normalizeInworldSpeakingRate(raw?.speakingRate),
    deliveryMode: normalizeInworldDeliveryMode(raw?.deliveryMode),
  };
}

function readInworldProviderConfig(config: SpeechProviderConfig) {
  return normalizeInworldProviderConfig({
    providers: { inworld: { ...config, apiKey: trimToUndefined(config.apiKey) } },
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
    speakingRate:
      normalizeInworldSpeakingRate(overrides?.speakingRate ?? overrides?.speed) ??
      config.speakingRate,
    deliveryMode: normalizeInworldDeliveryMode(overrides?.deliveryMode) ?? config.deliveryMode,
    timeoutMs: req.timeoutMs,
  });
}

const parseDirectiveToken = createSpeechDirectiveParser({
  temperature: [
    "allowVoiceSettings",
    ["temperature"],
    {
      number: {
        range: { min: 0, minExclusive: true, max: 2 },
        warning: (value) => `invalid Inworld temperature "${value}"`,
      },
    },
  ],
  voiceId: ["allowVoice", ["voice", "voiceid", "voice_id", "inworld_voice", "inworldvoice"]],
  modelId: ["allowModelId", ["model", "modelid", "model_id", "inworld_model", "inworldmodel"]],
  speakingRate: [
    "allowVoiceSettings",
    ["speed", "speaking_rate", "speakingrate", "inworld_speed", "inworldspeed"],
    {
      number: {
        range: INWORLD_SPEAKING_RATE_RANGE,
        warning: (value) => `invalid Inworld speaking rate "${value}" (0.5-1.5)`,
      },
    },
  ],
  deliveryMode: [
    "allowVoiceSettings",
    ["delivery", "delivery_mode", "deliverymode", "inworld_delivery"],
    {
      parse: ({ value }) => {
        const deliveryMode = normalizeInworldDeliveryMode(value);
        return deliveryMode
          ? { handled: true, overrides: { deliveryMode } }
          : {
              handled: true,
              warnings: [`invalid Inworld delivery mode "${value}" (stable, balanced, creative)`],
            };
      },
    },
  ],
});

export function buildInworldSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(resolveInworldApiKey(readInworldProviderConfig(providerConfig).apiKey));
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
        temperature:
          normalizeInworldTemperature(talkProviderConfig.temperature) ?? base.temperature,
        speakingRate:
          normalizeInworldSpeakingRate(talkProviderConfig.speakingRate) ?? base.speakingRate,
        deliveryMode:
          normalizeInworldDeliveryMode(talkProviderConfig.deliveryMode) ?? base.deliveryMode,
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
      // talk.speak carries pace as `speed` (TalkSpeakParamsSchema); map it to Inworld's speakingRate.
      ...(normalizeInworldSpeakingRate(params.speed) == null
        ? {}
        : { speakingRate: normalizeInworldSpeakingRate(params.speed) }),
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
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
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
