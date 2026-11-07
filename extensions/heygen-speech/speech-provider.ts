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
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  HEYGEN_MODELS,
  HEYGEN_MP3_OUTPUT,
  HEYGEN_PCM_OUTPUT,
  heygenHttpTtsStream,
  heygenSocketTtsStream,
  heygenTts,
  listHeyGenVoices,
  type HeyGenModel,
} from "./tts.js";

const HEYGEN_BASE_URL = "https://api.heygen.com";
const DEFAULT_MODEL: HeyGenModel = "heygen-voice-1-turbo";
// Public voice: Nadine.
const DEFAULT_VOICE_ID = "83548de556df48ba8c09c42a57c51d85";
const DEFAULT_TIMEOUT_MS = 120_000;

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

function normalizeStreamTransport(value: unknown) {
  const transport = trimToUndefined(value) ?? "http";
  if (transport === "http" || transport === "websocket") {
    return transport;
  }
  throw new Error(`invalid HeyGen streamTransport "${transport}"`);
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
    model: normalizeModel(raw?.model ?? raw?.modelId),
    voiceId: trimToUndefined(raw?.speakerVoiceId ?? raw?.voiceId) ?? DEFAULT_VOICE_ID,
    language: trimToUndefined(raw?.language),
    streamTransport: normalizeStreamTransport(raw?.streamTransport),
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

const parseDirectiveToken = createSpeechDirectiveParser({
  voiceId: ["allowVoice", ["voice", "voice_id", "heygen_voice"]],
  model: ["allowModelId", ["model", "heygen_model"]],
});

async function resolveSynthesisRequest(req: Omit<SpeechSynthesisRequest, "target">) {
  const config = readProviderConfig(req.providerConfig);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("HeyGen API key missing");
  }
  const overrides = req.providerOverrides ?? {};
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
    model: trimToUndefined(overrides.model) ? normalizeModel(overrides.model) : config.model,
    language: config.language,
    streamTransport: config.streamTransport,
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
    listVoices: async (req) => {
      const config = readProviderConfig(req.providerConfig ?? {});
      const apiKey = resolveApiKey(trimToUndefined(req.apiKey) ?? config.apiKey);
      if (!apiKey) {
        throw new Error("HeyGen API key missing");
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
      const { streamTransport, ...params } = await resolveSynthesisRequest(req);
      const streamParams = { ...params, maxBytes: Math.min(params.maxBytes, MAX_AUDIO_BYTES) };
      const stream =
        streamTransport === "websocket"
          ? await heygenSocketTtsStream(streamParams)
          : await heygenHttpTtsStream(streamParams);
      return { ...stream, ...MP3_RESULT };
    },
    synthesizeTelephony: async (req) => ({
      audioBuffer: await heygenTts(await resolveSynthesisRequest(req), HEYGEN_PCM_OUTPUT),
      outputFormat: "pcm",
      sampleRate: HEYGEN_PCM_OUTPUT.sample_rate_hertz,
    }),
  };
}
