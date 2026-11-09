import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech";
import {
  MAX_AUDIO_BYTES,
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  HEYGEN_MODELS,
  HEYGEN_MP3_OUTPUT,
  HEYGEN_PCM_OUTPUT,
  heygenTts,
  heygenTtsStream,
  listHeyGenVoices,
  type HeyGenModel,
} from "./tts.js";

const HEYGEN_BASE_URL = "https://api.heygen.com";
const DEFAULT_MODEL: HeyGenModel = "heygen-voice-1-turbo";
// Public voice: Nadine.
const DEFAULT_VOICE_ID = "83548de556df48ba8c09c42a57c51d85";
const DEFAULT_TIMEOUT_MS = 120_000;
const MISSING_API_KEY = "HeyGen API key missing: set HEYGEN_API_KEY or tts.providers.heygen.apiKey";

const MP3_RESULT = { outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: false };

function normalizeModel(value: unknown): HeyGenModel {
  const model = trimToUndefined(value);
  if (!model) {
    return DEFAULT_MODEL;
  }
  const supported = HEYGEN_MODELS.find((candidate) => candidate === model);
  if (supported) {
    return supported;
  }
  throw new Error(`invalid HeyGen model "${model}"`);
}

function normalizeBaseUrl(value: unknown): string {
  return trimToUndefined(value)?.replace(/\/+$/u, "") ?? HEYGEN_BASE_URL;
}

function normalizeProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.heygen);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.heygen.apiKey",
    }),
    baseUrl: normalizeBaseUrl(raw?.baseUrl),
    model: normalizeModel(raw?.modelId ?? raw?.model),
    voiceId:
      trimToUndefined(raw?.speakerVoice ?? raw?.speakerVoiceId ?? raw?.voiceId) ?? DEFAULT_VOICE_ID,
    language: trimToUndefined(raw?.language),
  };
}

function readProviderConfig(config: SpeechProviderConfig) {
  return normalizeProviderConfig({
    providers: { heygen: { ...config, apiKey: trimToUndefined(config.apiKey) } },
  });
}

function resolveApiKey(configValue?: string): string | undefined {
  return resolveSpeechProviderApiKey(configValue, process.env.HEYGEN_API_KEY);
}

const parseDirectiveToken = createSpeechDirectiveParser(
  {
    voiceId: ["allowVoice", ["voice", "voiceid", "voice_id", "heygen_voice"]],
    model: [
      "allowModelId",
      ["model", "heygen_model"],
      { value: (ctx) => normalizeModel(ctx.value) },
    ],
  },
  { formatErrorMessage: String },
);

async function resolveSynthesisRequest(req: Omit<SpeechSynthesisRequest, "target">) {
  const config = readProviderConfig(req.providerConfig);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error(MISSING_API_KEY);
  }
  const overrides = req.providerOverrides ?? {};
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: trimToUndefined(overrides.voiceId ?? overrides.voice) ?? config.voiceId,
    model: normalizeModel(trimToUndefined(overrides.model) ?? config.model),
    language: config.language,
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  };
}

export function buildHeyGenSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(resolveApiKey(readProviderConfig(providerConfig).apiKey));
  return {
    id: "heygen",
    label: "HeyGen Voice",
    autoSelectOrder: 30,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_MODEL,
    models: HEYGEN_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) =>
      readProviderConfig({ ...normalizeProviderConfig(baseTtsConfig), ...talkProviderConfig }),
    resolveTalkOverrides: ({ params }) =>
      filterStringRecord({
        voiceId: trimToUndefined(params.voiceId),
        model: trimToUndefined(params.modelId),
      }),
    listVoices: async (req) => {
      const config = readProviderConfig(req.providerConfig ?? {});
      const apiKey = resolveApiKey(trimToUndefined(req.apiKey) ?? config.apiKey);
      if (!apiKey) {
        throw new Error(MISSING_API_KEY);
      }
      return await listHeyGenVoices({
        apiKey,
        baseUrl: normalizeBaseUrl(req.baseUrl ?? config.baseUrl),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    // Synchronous SDK consumers need this through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      const audioBuffer = await heygenTts(params, HEYGEN_MP3_OUTPUT);
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer,
            inputExtension: "mp3",
            tempPrefix: "tts-heygen-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return { audioBuffer, ...MP3_RESULT };
    },
    streamSynthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      const maxBytes = Math.min(params.maxBytes, MAX_AUDIO_BYTES);
      return { ...(await heygenTtsStream({ ...params, maxBytes })), ...MP3_RESULT };
    },
    synthesizeTelephony: async (req) => ({
      audioBuffer: await heygenTts(await resolveSynthesisRequest(req), HEYGEN_PCM_OUTPUT),
      outputFormat: "pcm",
      sampleRate: HEYGEN_PCM_OUTPUT.sample_rate_hertz,
    }),
  };
}
