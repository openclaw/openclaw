import { parseStrictFiniteNumber, parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech";
import {
  createSpeechDirectiveParser,
  MAX_AUDIO_BYTES,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asBoolean,
  asFiniteNumberInRange,
  asOptionalRecord,
  asSafeIntegerInRange,
  normalizeOptionalString as trimToUndefined,
  normalizeLowercaseStringOrEmpty,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveElevenLabsApiKeyWithProfileFallback } from "./config-api.js";
import { isValidElevenLabsVoiceId, normalizeElevenLabsBaseUrl } from "./shared.js";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
};

const ELEVENLABS_TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

type ElevenLabsTtsRequestParams = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: string;
  languageCode?: string;
  latencyTier?: number;
  voiceSettings: typeof DEFAULT_ELEVENLABS_VOICE_SETTINGS;
  timeoutMs: number;
};

async function requestElevenLabsTts(params: ElevenLabsTtsRequestParams, stream: boolean) {
  const {
    text,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    latencyTier,
    voiceSettings,
  } = params;
  if (!isValidElevenLabsVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const url = new URL(`${baseUrl}/v1/text-to-speech/${voiceId}${stream ? "/stream" : ""}`);
  url.searchParams.set("output_format", outputFormat);
  const supportsStreamingLatency = modelId.trim().toLowerCase() !== "eleven_v3";
  if (latencyTier !== undefined && supportsStreamingLatency) {
    url.searchParams.set("optimize_streaming_latency", latencyTier.toString());
  }
  const normalizedOutputFormat = outputFormat.trim().toLowerCase();
  const acceptHeader =
    !normalizedOutputFormat || normalizedOutputFormat.startsWith("mp3_") ? "audio/mpeg" : undefined;
  const body = JSON.stringify({
    text,
    model_id: modelId,
    seed,
    apply_text_normalization: normalizedNormalization,
    language_code: normalizedLanguage,
    voice_settings: {
      stability: voiceSettings.stability,
      similarity_boost: voiceSettings.similarityBoost,
      style: voiceSettings.style,
      use_speaker_boost: voiceSettings.useSpeakerBoost,
      speed: voiceSettings.speed,
    },
  });
  const { assertOkOrThrowProviderError } = await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const result = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": params.apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: stream ? "elevenlabs.tts.stream" : "elevenlabs.tts",
  });
  try {
    await assertOkOrThrowProviderError(result.response, "ElevenLabs API error");
    return result;
  } catch (error) {
    await result.release();
    throw error;
  }
}

async function elevenLabsTTS(params: ElevenLabsTtsRequestParams): Promise<Buffer> {
  const { readProviderBinaryResponse } = await import("openclaw/plugin-sdk/provider-http");
  const { response, release } = await requestElevenLabsTts(params, false);
  try {
    return await readProviderBinaryResponse(response, "ElevenLabs API error", "audio");
  } finally {
    await release();
  }
}

function normalizeElevenLabsTtsModelId(value: string | undefined): string | undefined {
  switch (value) {
    case "eleven_turbo_v2_5":
      return "eleven_flash_v2_5";
    case "eleven_turbo_v2":
      return "eleven_flash_v2";
    default:
      return value;
  }
}

function normalizeElevenLabsSeed(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: 4_294_967_295 });
}

function normalizeElevenLabsLatencyTier(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: 4 });
}

const ELEVENLABS_OUTPUT_FAMILIES = new Set(["opus", "mp3", "pcm", "ulaw", "alaw", "wav"]);

function resolveElevenLabsOutputPlan(req: SpeechSynthesisRequest) {
  const outputFormat =
    trimToUndefined(req.providerOverrides?.outputFormat) ??
    (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
  const family = outputFormat.trim().toLowerCase().split("_", 1)[0];
  return {
    outputFormat,
    fileExtension: family && ELEVENLABS_OUTPUT_FAMILIES.has(family) ? `.${family}` : ".bin",
    voiceCompatible: family === "opus",
  };
}

function definedSettings<T extends Record<string, unknown>>(settings: T): Partial<T> {
  for (const key in settings) {
    if (settings[key] === undefined) {
      delete settings[key];
    }
  }
  return settings;
}

function normalizeVoiceSettings(
  raw: Record<string, unknown> | undefined,
): Partial<typeof DEFAULT_ELEVENLABS_VOICE_SETTINGS> {
  return definedSettings({
    stability: asFiniteNumberInRange(raw?.stability, { min: 0, max: 1 }),
    similarityBoost: asFiniteNumberInRange(raw?.similarityBoost, { min: 0, max: 1 }),
    style: asFiniteNumberInRange(raw?.style, { min: 0, max: 1 }),
    useSpeakerBoost: asBoolean(raw?.useSpeakerBoost),
    speed: asFiniteNumberInRange(raw?.speed, { min: 0.5, max: 2 }),
  });
}

function normalizeElevenLabsProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.elevenlabs);
  const rawVoiceSettings = asOptionalRecord(raw?.voiceSettings);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.elevenlabs.apiKey",
    }),
    baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID,
    modelId:
      normalizeElevenLabsTtsModelId(trimToUndefined(raw?.modelId)) ?? DEFAULT_ELEVENLABS_MODEL_ID,
    seed: normalizeElevenLabsSeed(raw?.seed),
    applyTextNormalization: trimToUndefined(raw?.applyTextNormalization),
    languageCode: trimToUndefined(raw?.languageCode),
    voiceSettings: {
      ...DEFAULT_ELEVENLABS_VOICE_SETTINGS,
      ...normalizeVoiceSettings(rawVoiceSettings),
    },
  };
}

function readElevenLabsProviderConfig(config: SpeechProviderConfig) {
  return normalizeElevenLabsProviderConfig({
    providers: { elevenlabs: { ...config, apiKey: trimToUndefined(config.apiKey) } },
  });
}

function resolveElevenLabsApiKey(...candidates: Array<string | undefined>): string | undefined {
  return resolveSpeechProviderApiKey(
    ...candidates,
    resolveElevenLabsApiKeyWithProfileFallback() ?? undefined,
    process.env.XI_API_KEY,
  );
}

type ElevenLabsSynthesisRequest = Pick<
  SpeechSynthesisRequest,
  "providerConfig" | "providerOverrides" | "text" | "timeoutMs"
>;

function resolveElevenLabsTtsRequest(
  req: ElevenLabsSynthesisRequest,
  options: Pick<ElevenLabsTtsRequestParams, "outputFormat" | "latencyTier">,
): ElevenLabsTtsRequestParams {
  const config = readElevenLabsProviderConfig(req.providerConfig);
  const overrides = req.providerOverrides ?? {};
  const apiKey = resolveElevenLabsApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
    modelId: normalizeElevenLabsTtsModelId(trimToUndefined(overrides.modelId)) ?? config.modelId,
    outputFormat: options.outputFormat,
    seed: normalizeElevenLabsSeed(overrides.seed) ?? config.seed,
    applyTextNormalization:
      trimToUndefined(overrides.applyTextNormalization) ?? config.applyTextNormalization,
    languageCode: trimToUndefined(overrides.languageCode) ?? config.languageCode,
    latencyTier: options.latencyTier,
    voiceSettings: {
      ...config.voiceSettings,
      ...normalizeVoiceSettings(asOptionalRecord(overrides.voiceSettings)),
    },
    timeoutMs: req.timeoutMs,
  };
}

export function buildElevenLabsSpeechProvider({
  formatErrorMessage,
}: Pick<PluginCapabilityCatalogContext, "formatErrorMessage">): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(resolveElevenLabsApiKey(readElevenLabsProviderConfig(providerConfig).apiKey));
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    autoSelectOrder: 20,
    defaultModel: DEFAULT_ELEVENLABS_MODEL_ID,
    models: ELEVENLABS_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeElevenLabsProviderConfig(rawConfig),
    parseDirectiveToken: createSpeechDirectiveParser(
      {
        voiceid: [
          "allowVoice",
          ["voiceid", "voice_id", "elevenlabs_voice", "elevenlabsvoice"],
          {
            parse: (ctx) =>
              isValidElevenLabsVoiceId(ctx.value)
                ? { handled: true, overrides: { voiceId: ctx.value } }
                : { handled: true, warnings: [`invalid ElevenLabs voiceId "${ctx.value}"`] },
          },
        ],
        modelId: [
          "allowModelId",
          ["model", "modelid", "model_id", "elevenlabs_model", "elevenlabsmodel"],
          { value: (ctx) => normalizeElevenLabsTtsModelId(ctx.value) },
        ],
        stability: [
          "allowVoiceSettings",
          ["stability", "similarity", "similarityboost", "similarity_boost", "style", "speed"],
          {
            parse: (ctx) => {
              const setting = ctx.key.startsWith("similarity") ? "similarityBoost" : ctx.key;
              const value = parseStrictFiniteNumber(ctx.value);
              if (value == null) {
                return { handled: true, warnings: [`invalid ${setting} value`] };
              }
              requireInRange(
                value,
                setting === "speed" ? 0.5 : 0,
                setting === "speed" ? 2 : 1,
                setting,
              );
              return {
                handled: true,
                overrides: {
                  voiceSettings: {
                    ...asOptionalRecord(ctx.currentOverrides?.voiceSettings),
                    [setting]: value,
                  },
                },
              };
            },
          },
        ],
        speakerboost: [
          "allowVoiceSettings",
          ["speakerboost", "speaker_boost", "usespeakerboost", "use_speaker_boost"],
          {
            parse: (ctx) => {
              const value = parseBooleanValue(ctx.value);
              return value == null
                ? { handled: true, warnings: ["invalid useSpeakerBoost value"] }
                : {
                    handled: true,
                    overrides: {
                      voiceSettings: {
                        ...asOptionalRecord(ctx.currentOverrides?.voiceSettings),
                        useSpeakerBoost: value,
                      },
                    },
                  };
            },
          },
        ],
        applyTextNormalization: [
          "allowNormalization",
          ["normalize", "applytextnormalization", "apply_text_normalization"],
          { value: (ctx) => normalizeApplyTextNormalization(ctx.value) },
        ],
        languageCode: [
          "allowNormalization",
          ["language", "languagecode", "language_code"],
          { value: (ctx) => normalizeLanguageCode(ctx.value) },
        ],
        seed: [
          "allowSeed",
          ["seed"],
          { value: (ctx) => normalizeSeed(parseStrictInteger(ctx.value) ?? Number.NaN) },
        ],
      },
      { formatErrorMessage },
    ),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeElevenLabsProviderConfig(baseTtsConfig);
      const talkVoiceSettings = asOptionalRecord(talkProviderConfig.voiceSettings);
      const resolvedTalkApiKey =
        talkProviderConfig.apiKey === undefined
          ? resolveElevenLabsApiKey()
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.elevenlabs.apiKey",
            });
      return {
        ...base,
        ...(resolvedTalkApiKey === undefined ? {} : { apiKey: resolvedTalkApiKey }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...definedSettings({
          voiceId: trimToUndefined(talkProviderConfig.voiceId),
          modelId: normalizeElevenLabsTtsModelId(trimToUndefined(talkProviderConfig.modelId)),
          seed: normalizeElevenLabsSeed(talkProviderConfig.seed),
          applyTextNormalization: normalizeApplyTextNormalization(
            trimToUndefined(talkProviderConfig.applyTextNormalization),
          ),
          languageCode: normalizeLanguageCode(trimToUndefined(talkProviderConfig.languageCode)),
        }),
        voiceSettings: {
          ...base.voiceSettings,
          ...normalizeVoiceSettings(talkVoiceSettings),
        },
      };
    },
    resolveTalkOverrides: ({ params }) => {
      const normalize = trimToUndefined(params.normalize);
      const language = normalizeLowercaseStringOrEmpty(trimToUndefined(params.language));
      const latencyTier = normalizeElevenLabsLatencyTier(params.latencyTier);
      const voiceSettings = normalizeVoiceSettings({
        speed: params.speed,
        stability: params.stability,
        similarityBoost: params.similarity,
        style: params.style,
        useSpeakerBoost: params.speakerBoost,
      });
      return {
        ...definedSettings({
          voiceId: trimToUndefined(params.voiceId),
          modelId: normalizeElevenLabsTtsModelId(trimToUndefined(params.modelId)),
          outputFormat: trimToUndefined(params.outputFormat),
          seed: normalizeElevenLabsSeed(params.seed),
        }),
        ...(normalize == null
          ? {}
          : { applyTextNormalization: normalizeApplyTextNormalization(normalize) }),
        languageCode: normalizeLanguageCode(language),
        ...(latencyTier == null ? {} : { latencyTier }),
        ...(Object.keys(voiceSettings).length === 0 ? {} : { voiceSettings }),
      };
    },
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readElevenLabsProviderConfig(req.providerConfig)
        : undefined;
      const apiKey = resolveElevenLabsApiKey(req.apiKey, config?.apiKey);
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const normalizedBaseUrl = normalizeElevenLabsBaseUrl(req.baseUrl ?? config?.baseUrl);
      const { assertOkOrThrowProviderError, readProviderJsonResponse } =
        await import("openclaw/plugin-sdk/provider-http");
      const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
        await import("openclaw/plugin-sdk/ssrf-runtime");
      const { response, release } = await fetchWithSsrFGuard({
        url: `${normalizedBaseUrl}/v1/voices`,
        init: {
          headers: {
            "xi-api-key": apiKey,
          },
        },
        timeoutMs: req.timeoutMs,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
        auditContext: "elevenlabs.voices",
      });
      try {
        await assertOkOrThrowProviderError(response, "ElevenLabs voices API error");
        const json = await readProviderJsonResponse<{
          voices?: Array<{
            voice_id?: string;
            name?: string;
            category?: string;
            description?: string;
          }>;
        }>(response, "elevenlabs.voices");
        return Array.isArray(json.voices)
          ? json.voices
              .map((voice) => ({
                id: voice.voice_id?.trim() ?? "",
                name: trimToUndefined(voice.name),
                category: trimToUndefined(voice.category),
                description: trimToUndefined(voice.description),
              }))
              .filter((voice) => voice.id.length > 0)
          : [];
      } finally {
        await release();
      }
    },
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const overrides = req.providerOverrides ?? {};
      const outputPlan = resolveElevenLabsOutputPlan(req);
      const audioBuffer = await elevenLabsTTS(
        resolveElevenLabsTtsRequest(req, {
          outputFormat: outputPlan.outputFormat,
          latencyTier: normalizeElevenLabsLatencyTier(overrides.latencyTier),
        }),
      );
      return {
        audioBuffer,
        ...outputPlan,
      };
    },
    streamSynthesize: async (req) => {
      const overrides = req.providerOverrides ?? {};
      const outputPlan = resolveElevenLabsOutputPlan(req);
      const params = resolveElevenLabsTtsRequest(req, {
        outputFormat: outputPlan.outputFormat,
        latencyTier: normalizeElevenLabsLatencyTier(overrides.latencyTier),
      });
      const { createBoundedProviderBinaryStream } =
        await import("openclaw/plugin-sdk/provider-binary-stream");
      const { assertProviderBinaryResponseContent } =
        await import("openclaw/plugin-sdk/provider-http");
      const { response, release } = await requestElevenLabsTts(params, true);
      try {
        assertProviderBinaryResponseContent(response, "ElevenLabs API error", "audio");
        if (!response.body) {
          throw new Error("ElevenLabs API response missing audio stream");
        }
        const boundedStream = createBoundedProviderBinaryStream(response.body, {
          maxBytes: MAX_AUDIO_BYTES,
          createOverflowError: ({ maxBytes }) =>
            new Error(`ElevenLabs API error: audio response exceeds ${maxBytes} bytes`),
          createReleaseError: () => new Error("ElevenLabs TTS stream released"),
          cleanup: release,
        });
        return {
          audioStream: boundedStream.stream,
          ...outputPlan,
          release: boundedStream.release,
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
    synthesizeTelephony: async (req) => {
      const outputFormat = "pcm_22050";
      const sampleRate = 22_050;
      const audioBuffer = await elevenLabsTTS(resolveElevenLabsTtsRequest(req, { outputFormat }));
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
