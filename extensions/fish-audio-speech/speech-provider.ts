import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import {
  MAX_AUDIO_BYTES,
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asBoolean,
  asFiniteNumberInRange,
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FISH_AUDIO_MODELS,
  type FishAudioFormat,
  type FishAudioLatency,
  type FishAudioModel,
  type FishAudioTtsRequest,
  fishAudioTts,
  fishAudioTtsStream,
  listFishAudioVoices,
  normalizeFishAudioBaseUrl,
} from "./tts.js";

const DEFAULT_MODEL: FishAudioModel = "s2.1-pro";
const DEFAULT_LATENCY: FishAudioLatency = "balanced";
const DEFAULT_TIMEOUT_MS = 240_000;

type FishAudioOverrides = Partial<
  Omit<ReturnType<typeof normalizeProviderConfig>, "apiKey" | "baseUrl">
>;

function normalizeModel(value: unknown): FishAudioModel {
  const model = trimToUndefined(value);
  if (!model) {
    return DEFAULT_MODEL;
  }
  const supported = FISH_AUDIO_MODELS.find((candidate) => candidate === model);
  if (supported) {
    return supported;
  }
  throw new Error(`invalid Fish Audio model "${model}"`);
}

function normalizeLatency(value: unknown): FishAudioLatency {
  const latency = trimToUndefined(value)?.toLowerCase();
  if (!latency) {
    return DEFAULT_LATENCY;
  }
  if (latency === "low" || latency === "balanced" || latency === "normal") {
    return latency;
  }
  throw new Error(`invalid Fish Audio latency "${latency}"`);
}

function resolveReferenceId(raw: Record<string, unknown> | undefined): string | undefined {
  return trimToUndefined(raw?.speakerVoiceId ?? raw?.voiceId ?? raw?.referenceId);
}

function normalizeProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.["fish-audio"]);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.fish-audio.apiKey",
    }),
    baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(raw?.baseUrl)),
    model: normalizeModel(raw?.model ?? raw?.modelId),
    referenceId: resolveReferenceId(raw),
    latency: normalizeLatency(raw?.latency),
    speed: asFiniteNumberInRange(raw?.speed, { min: 0.5, max: 2 }),
    temperature: asFiniteNumberInRange(raw?.temperature, { min: 0, max: 1 }),
    topP: asFiniteNumberInRange(raw?.topP ?? raw?.top_p, { min: 0, max: 1 }),
    normalize: asBoolean(raw?.normalize),
  };
}

function readProviderConfig(config: SpeechProviderConfig) {
  return normalizeProviderConfig({
    providers: { "fish-audio": { ...config, apiKey: trimToUndefined(config.apiKey) } },
  });
}

function readOverrides(overrides: SpeechProviderOverrides | undefined): FishAudioOverrides {
  const raw = overrides ?? {};
  return {
    model: trimToUndefined(raw.model ?? raw.modelId)
      ? normalizeModel(raw.model ?? raw.modelId)
      : undefined,
    referenceId: resolveReferenceId(raw),
    latency: trimToUndefined(raw.latency) ? normalizeLatency(raw.latency) : undefined,
    speed: asFiniteNumberInRange(raw.speed, { min: 0.5, max: 2 }),
    temperature: asFiniteNumberInRange(raw.temperature, { min: 0, max: 1 }),
    topP: asFiniteNumberInRange(raw.topP ?? raw.top_p, { min: 0, max: 1 }),
    normalize: asBoolean(raw.normalize),
  };
}

function resolveApiKey(configValue?: string): string | undefined {
  return resolveSpeechProviderApiKey(
    configValue,
    process.env.FISH_API_KEY,
    process.env.FISH_AUDIO_API_KEY,
  );
}

const parseDirectiveToken = createSpeechDirectiveParser(
  {
    referenceId: [
      "allowVoice",
      [
        "voice",
        "voiceid",
        "voice_id",
        "referenceid",
        "reference_id",
        "fish_voice",
        "fishaudio_voice",
      ],
    ],
    model: [
      "allowModelId",
      ["model", "modelid", "model_id", "fish_model", "fishaudio_model"],
      { value: (ctx) => normalizeModel(ctx.value) },
    ],
    speed: [
      "allowVoiceSettings",
      ["speed", "fish_speed"],
      {
        number: {
          range: { min: 0.5, max: 2 },
          warning: (value) => `invalid Fish Audio speed "${value}"`,
        },
      },
    ],
    temperature: [
      "allowVoiceSettings",
      ["temperature", "fish_temperature"],
      {
        number: {
          range: { min: 0, max: 1 },
          warning: (value) => `invalid Fish Audio temperature "${value}"`,
        },
      },
    ],
    topP: [
      "allowVoiceSettings",
      ["top_p", "topp", "fish_top_p"],
      {
        number: {
          range: { min: 0, max: 1 },
          warning: (value) => `invalid Fish Audio top_p "${value}"`,
        },
      },
    ],
    latency: [
      "allowVoiceSettings",
      ["latency", "fish_latency"],
      { value: (ctx) => normalizeLatency(ctx.value) },
    ],
    normalize: [
      "allowNormalization",
      ["normalize", "fish_normalize"],
      {
        parse: (ctx) => {
          const normalize = parseBooleanValue(ctx.value);
          return normalize !== undefined
            ? { handled: true, overrides: { normalize } }
            : { handled: true, warnings: [`invalid Fish Audio normalize "${ctx.value}"`] };
        },
      },
    ],
  },
  { formatErrorMessage: String },
);

function resolveFormat(target: SpeechSynthesisTarget): {
  format: FishAudioFormat;
  sampleRate?: number;
  fileExtension: string;
  voiceCompatible: boolean;
} {
  if (target === "voice-note") {
    return { format: "opus", sampleRate: 48_000, fileExtension: ".opus", voiceCompatible: true };
  }
  if (target === "telephony") {
    return { format: "pcm", sampleRate: 8_000, fileExtension: ".pcm", voiceCompatible: false };
  }
  return { format: "mp3", sampleRate: 44_100, fileExtension: ".mp3", voiceCompatible: false };
}

async function resolveSynthesisRequest(
  req: SpeechSynthesisRequest,
): Promise<FishAudioTtsRequest & { fileExtension: string; voiceCompatible: boolean }> {
  const config = readProviderConfig(req.providerConfig);
  const overrides = readOverrides(req.providerOverrides);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Fish Audio API key missing");
  }
  const output = resolveFormat(req.target);
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    model: overrides.model ?? config.model,
    referenceId: overrides.referenceId ?? config.referenceId,
    latency: overrides.latency ?? config.latency,
    speed: overrides.speed ?? config.speed,
    temperature: overrides.temperature ?? config.temperature,
    topP: overrides.topP ?? config.topP,
    normalize: overrides.normalize ?? config.normalize,
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
    ...output,
  };
}

export function buildFishAudioSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(resolveApiKey(readProviderConfig(providerConfig).apiKey));
  return {
    id: "fish-audio",
    label: "Fish Audio",
    autoSelectOrder: 28,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_MODEL,
    models: FISH_AUDIO_MODELS,
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
                path: "talk.providers.fish-audio.apiKey",
              }),
            }),
        ...filterStringRecord({
          baseUrl: trimToUndefined(talkProviderConfig.baseUrl)
            ? normalizeFishAudioBaseUrl(trimToUndefined(talkProviderConfig.baseUrl))
            : undefined,
          model: trimToUndefined(talkProviderConfig.modelId ?? talkProviderConfig.model)
            ? normalizeModel(talkProviderConfig.modelId ?? talkProviderConfig.model)
            : undefined,
          referenceId: resolveReferenceId(talkProviderConfig),
          latency: trimToUndefined(talkProviderConfig.latency)
            ? normalizeLatency(talkProviderConfig.latency)
            : undefined,
        }),
        ...(asFiniteNumberInRange(talkProviderConfig.speed, { min: 0.5, max: 2 }) == null
          ? {}
          : { speed: asFiniteNumberInRange(talkProviderConfig.speed, { min: 0.5, max: 2 }) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...filterStringRecord({
        model: trimToUndefined(params.modelId ?? params.model)
          ? normalizeModel(params.modelId ?? params.model)
          : undefined,
        referenceId: resolveReferenceId(params),
      }),
      ...(asFiniteNumberInRange(params.speed, { min: 0.5, max: 2 }) == null
        ? {}
        : { speed: asFiniteNumberInRange(params.speed, { min: 0.5, max: 2 }) }),
    }),
    listVoices: async (req) => {
      const config = readProviderConfig(req.providerConfig ?? {});
      const apiKey = resolveApiKey(trimToUndefined(req.apiKey) ?? config.apiKey);
      if (!apiKey) {
        throw new Error("Fish Audio API key missing");
      }
      return await listFishAudioVoices({
        apiKey,
        baseUrl: normalizeFishAudioBaseUrl(trimToUndefined(req.baseUrl) ?? config.baseUrl),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      return {
        audioBuffer: await fishAudioTts(params),
        outputFormat: params.format,
        fileExtension: params.fileExtension,
        voiceCompatible: params.voiceCompatible,
      };
    },
    streamSynthesize: async (req) => {
      const params = await resolveSynthesisRequest(req);
      const stream = await fishAudioTtsStream({
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
        audioBuffer: await fishAudioTts(params),
        outputFormat: "pcm",
        sampleRate: 8_000,
      };
    },
  };
}
