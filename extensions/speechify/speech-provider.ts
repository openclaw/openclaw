import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import { MAX_AUDIO_BYTES, resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_SPEECHIFY_MODEL,
  DEFAULT_SPEECHIFY_VOICE_ID,
  SPEECHIFY_MODELS,
  normalizeSpeechifyBaseUrl,
} from "./shared.js";
import {
  type SpeechifyAudioFormat,
  type SpeechifyTtsRequest,
  listSpeechifyVoices,
  speechifyTts,
  speechifyTtsStream,
} from "./tts.js";

// A 20,000-character request streams for a few minutes; leave room for that.
const DEFAULT_TIMEOUT_MS = 240_000;

function resolveVoiceId(raw: Record<string, unknown> | undefined): string | undefined {
  return trimToUndefined(raw?.speakerVoiceId ?? raw?.voiceId);
}

function resolveModel(raw: Record<string, unknown> | undefined): string | undefined {
  return trimToUndefined(raw?.model ?? raw?.modelId);
}

function normalizeProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.speechify) ?? asOptionalRecord(rawConfig.speechify);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.speechify.apiKey",
    }),
    baseUrl: normalizeSpeechifyBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: resolveVoiceId(raw) ?? DEFAULT_SPEECHIFY_VOICE_ID,
    model: resolveModel(raw) ?? DEFAULT_SPEECHIFY_MODEL,
    language: trimToUndefined(raw?.language),
  };
}

function readProviderConfig(config: SpeechProviderConfig) {
  return normalizeProviderConfig({
    speechify: { ...config, apiKey: trimToUndefined(config.apiKey) },
  });
}

function readOverrides(overrides: SpeechProviderOverrides | undefined) {
  const raw = asOptionalRecord(overrides);
  return {
    voiceId: resolveVoiceId(raw),
    model: resolveModel(raw),
    language: trimToUndefined(raw?.language),
  };
}

function resolveApiKey(configValue?: string): string | undefined {
  return resolveSpeechProviderApiKey(configValue, process.env.SPEECHIFY_API_KEY);
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "speechify_voice":
    case "speechifyvoice":
      return ctx.policy.allowVoice
        ? { handled: true, overrides: { ...ctx.currentOverrides, voiceId: ctx.value } }
        : { handled: true };
    case "model":
    case "modelid":
    case "model_id":
    case "speechify_model":
    case "speechifymodel":
      return ctx.policy.allowModelId
        ? { handled: true, overrides: { ...ctx.currentOverrides, model: ctx.value } }
        : { handled: true };
    case "language":
    case "lang":
    case "speechify_language":
      return ctx.policy.allowVoiceSettings
        ? { handled: true, overrides: { ...ctx.currentOverrides, language: ctx.value } }
        : { handled: true };
    default:
      return { handled: false };
  }
}

function resolveFormat(target: SpeechSynthesisTarget): {
  format: SpeechifyAudioFormat;
  fileExtension: string;
  voiceCompatible: boolean;
} {
  if (target === "voice-note") {
    return { format: "ogg", fileExtension: ".ogg", voiceCompatible: true };
  }
  if (target === "telephony") {
    return { format: "pcm", fileExtension: ".pcm", voiceCompatible: false };
  }
  return { format: "mp3", fileExtension: ".mp3", voiceCompatible: false };
}

async function resolveSynthesisRequest(
  req: SpeechSynthesisRequest,
): Promise<SpeechifyTtsRequest & { fileExtension: string; voiceCompatible: boolean }> {
  const config = readProviderConfig(req.providerConfig);
  const overrides = readOverrides(req.providerOverrides);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Speechify API key missing");
  }
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: overrides.voiceId ?? config.voiceId,
    model: overrides.model ?? config.model,
    language: overrides.language ?? config.language,
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
    ...resolveFormat(req.target),
  };
}

function isProviderConfigured(config: SpeechProviderConfig): boolean {
  try {
    return Boolean(resolveApiKey(readProviderConfig(config).apiKey));
  } catch {
    // Provider selection is a predicate; synthesis reports the precise URL error.
    return false;
  }
}

export function buildSpeechifySpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    isProviderConfigured(providerConfig);
  return {
    id: "speechify",
    label: "Speechify",
    autoSelectOrder: 30,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_SPEECHIFY_MODEL,
    models: SPEECHIFY_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.speechify.apiKey",
              }),
            }),
        ...filterStringRecord({
          baseUrl: trimToUndefined(talkProviderConfig.baseUrl)
            ? normalizeSpeechifyBaseUrl(trimToUndefined(talkProviderConfig.baseUrl))
            : undefined,
          voiceId: resolveVoiceId(talkProviderConfig),
          model: resolveModel(talkProviderConfig),
          language: trimToUndefined(talkProviderConfig.language),
        }),
      };
    },
    resolveTalkOverrides: ({ params }) =>
      filterStringRecord({
        voiceId: resolveVoiceId(params),
        model: resolveModel(params),
        language: trimToUndefined(params.language),
      }),
    listVoices: async (req) => {
      const config = readProviderConfig(req.providerConfig ?? {});
      const apiKey = resolveApiKey(trimToUndefined(req.apiKey) ?? config.apiKey);
      if (!apiKey) {
        throw new Error("Speechify API key missing");
      }
      return await listSpeechifyVoices({
        apiKey,
        baseUrl: normalizeSpeechifyBaseUrl(trimToUndefined(req.baseUrl) ?? config.baseUrl),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      return {
        audioBuffer: await speechifyTts(params),
        outputFormat: params.format,
        fileExtension: params.fileExtension,
        voiceCompatible: params.voiceCompatible,
      };
    },
    streamSynthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      const stream = await speechifyTtsStream({
        ...params,
        maxBytes: Math.min(params.maxBytes, MAX_AUDIO_BYTES),
      });
      return {
        audioStream: stream.audioStream,
        outputFormat: params.format,
        fileExtension: params.fileExtension,
        voiceCompatible: params.voiceCompatible,
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const params = await resolveSynthesisRequest({ ...req, target: "telephony" });
      return {
        audioBuffer: await speechifyTts(params),
        outputFormat: "pcm",
        sampleRate: 24_000,
      };
    },
  };
}
