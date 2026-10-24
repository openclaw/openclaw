import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderPlugin, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import {
  createSpeechDirectiveParser,
  parseSpeechDirectiveNumberOverride,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAIProviderConfigRecord } from "./realtime-provider-shared.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const OPENAI_TTS_MODELS = [
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
] as const;

const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

function normalizeOpenAITtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function isCustomOpenAITtsBaseUrl(baseUrl?: string): boolean {
  return (
    normalizeOpenAITtsBaseUrl(baseUrl ?? process.env.OPENAI_TTS_BASE_URL) !==
    DEFAULT_OPENAI_BASE_URL
  );
}

function isValidOpenAIModel(model: string, baseUrl?: string): boolean {
  if (isCustomOpenAITtsBaseUrl(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_MODELS.some((candidate) => candidate === model);
}

function isValidOpenAIVoice(voice: string, baseUrl?: string): voice is OpenAiTtsVoice {
  if (isCustomOpenAITtsBaseUrl(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_VOICES.some((candidate) => candidate === voice);
}

function resolveOpenAITtsInstructions(
  model: string,
  instructions?: string,
  baseUrl?: string,
): string | undefined {
  const next = instructions?.trim();
  if (!next) {
    return undefined;
  }
  if (baseUrl !== undefined && isCustomOpenAITtsBaseUrl(baseUrl)) {
    return next;
  }
  return model.includes("gpt-4o-mini-tts") ? next : undefined;
}

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

const OPENAI_SPEECH_RESPONSE_FORMATS = ["mp3", "opus", "wav"] as const;

type OpenAiSpeechResponseFormat = (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number];

function resolveOpenAISpeechApiKey(
  config: Partial<Pick<ReturnType<typeof normalizeOpenAIProviderConfig>, "apiKey">>,
): string | undefined {
  return config.apiKey ?? normalizeOptionalString(process.env.OPENAI_API_KEY);
}

function normalizeOpenAISpeechResponseFormat(
  value: unknown,
): OpenAiSpeechResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  const format = OPENAI_SPEECH_RESPONSE_FORMATS.find((candidate) => candidate === next);
  if (format) {
    return format;
  }
  throw new Error(`Invalid OpenAI speech responseFormat: ${next}`);
}

function isGroqSpeechBaseUrl(baseUrl: string): boolean {
  const hostname = normalizeLowercaseStringOrEmpty(URL.parse(baseUrl)?.hostname);
  return hostname === "groq.com" || hostname.endsWith(".groq.com");
}

function resolveSpeechResponseFormat(
  baseUrl: string,
  target: "audio-file" | "voice-note" | "telephony",
  configuredFormat?: OpenAiSpeechResponseFormat,
): OpenAiSpeechResponseFormat {
  if (configuredFormat) {
    return configuredFormat;
  }
  if (isGroqSpeechBaseUrl(baseUrl)) {
    return "wav";
  }
  return target === "voice-note" ? "opus" : "mp3";
}

function readExtraBody(value: unknown): Record<string, unknown> | undefined {
  const body = asOptionalRecord(value);
  if (!body || Object.keys(body).length === 0) {
    return undefined;
  }
  return body;
}

function normalizeOpenAISpeechSpeed(value: unknown, baseUrl?: string): number | undefined {
  const speed = asFiniteNumber(value);
  if (speed === undefined) {
    return undefined;
  }
  if (baseUrl !== undefined && normalizeOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_BASE_URL) {
    return speed;
  }
  return speed >= 0.25 && speed <= 4 ? speed : undefined;
}

function normalizeOpenAIProviderConfig(
  config: Record<string, unknown>,
  source: "raw" | "resolved" = "raw",
) {
  const raw = source === "raw" ? resolveOpenAIProviderConfigRecord(config) : config;
  const configuredBaseUrl = normalizeOptionalString(raw.baseUrl);
  const defaultBaseUrl =
    normalizeOptionalString(process.env.OPENAI_TTS_BASE_URL) ?? DEFAULT_OPENAI_BASE_URL;
  const baseUrl =
    source === "raw"
      ? normalizeOpenAITtsBaseUrl(configuredBaseUrl ?? defaultBaseUrl)
      : (configuredBaseUrl ?? normalizeOpenAITtsBaseUrl(defaultBaseUrl));
  return {
    apiKey:
      source === "raw"
        ? normalizeResolvedSecretInputString({
            value: raw.apiKey,
            path: "tts.providers.openai.apiKey",
          })
        : normalizeOptionalString(raw.apiKey),
    baseUrl,
    model: normalizeOptionalString(raw.model) ?? "gpt-4o-mini-tts",
    voice: normalizeOptionalString(raw.voice) ?? "coral",
    speed: normalizeOpenAISpeechSpeed(raw.speed, baseUrl),
    instructions: normalizeOptionalString(raw.instructions),
    responseFormat: normalizeOpenAISpeechResponseFormat(raw.responseFormat),
    extraBody: readExtraBody(raw.extraBody) ?? readExtraBody(raw.extra_body),
  };
}

const parseDirectiveToken = createSpeechDirectiveParser({
  voice: [
    "allowVoice",
    ["voice", "openai_voice", "openaivoice"],
    {
      parse: (ctx) =>
        isValidOpenAIVoice(ctx.value, normalizeOptionalString(ctx.providerConfig?.baseUrl))
          ? { handled: true, overrides: { voice: ctx.value } }
          : { handled: true, warnings: [`invalid OpenAI voice "${ctx.value}"`] },
    },
  ],
  model: [
    "allowModelId",
    ["model", "openai_model", "openaimodel"],
    {
      parse: (ctx) =>
        isValidOpenAIModel(ctx.value, normalizeOptionalString(ctx.providerConfig?.baseUrl))
          ? { handled: true, overrides: { model: ctx.value } }
          : { handled: false },
    },
  ],
  speed: [
    "allowVoiceSettings",
    ["speed", "openai_speed", "openaispeed"],
    {
      parse: (ctx) => {
        const customBaseUrl = isCustomOpenAITtsBaseUrl(
          normalizeOptionalString(ctx.providerConfig?.baseUrl),
        );
        return parseSpeechDirectiveNumberOverride({
          ctx,
          overrideKey: "speed",
          range: customBaseUrl ? {} : { min: 0.25, max: 4 },
          warning: (value) =>
            customBaseUrl
              ? `invalid OpenAI-compatible speed "${value}"`
              : `invalid OpenAI speed "${value}" (0.25-4.0)`,
        });
      },
    },
  ],
});

async function synthesizeOpenAISpeech(req: SpeechSynthesisRequest, responseFormatOverride?: "pcm") {
  const config = normalizeOpenAIProviderConfig(req.providerConfig, "resolved");
  const model = normalizeOptionalString(req.providerOverrides?.model) ?? config.model;
  const voice = normalizeOptionalString(req.providerOverrides?.voice) ?? config.voice;
  const speed =
    normalizeOpenAISpeechSpeed(req.providerOverrides?.speed, config.baseUrl) ?? config.speed;
  const apiKey = resolveOpenAISpeechApiKey(config);
  if (!apiKey) {
    throw new Error("OpenAI API key missing");
  }
  const responseFormat =
    responseFormatOverride ??
    resolveSpeechResponseFormat(config.baseUrl, req.target, config.responseFormat);
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const { text, timeoutMs } = req;
  const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");
  const effectiveInstructions = resolveOpenAITtsInstructions(
    model,
    config.instructions,
    config.baseUrl,
  );

  if (!isValidOpenAIModel(model, config.baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, config.baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }
  const {
    assertOkOrThrowProviderError,
    readProviderBinaryResponse,
    resolveProviderRequestHeaders,
  } = await import("openclaw/plugin-sdk/provider-http");
  const proxyCaptureSdk = await import("openclaw/plugin-sdk/proxy-capture");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");

  const requestHeaders = omitNullRequestHeaders(
    resolveProviderRequestHeaders({
      provider: "openai",
      baseUrl: config.baseUrl,
      capability: "audio",
      transport: "http",
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }),
  ) ?? {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const requestBody = JSON.stringify({
    model,
    input: text,
    voice,
    response_format: responseFormat,
    ...(speed != null && { speed }),
    ...(effectiveInstructions != null && { instructions: effectiveInstructions }),
    ...(config.extraBody == null ? {} : sanitizeExtraBodyRecord(config.extraBody)),
  });
  const requestUrl = `${config.baseUrl}/audio/speech`;
  const debugProxyFetchPatchInstalled = proxyCaptureSdk.isDebugProxyGlobalFetchPatchInstalled();
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    init: {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(config.baseUrl),
    capture: false,
    pinDns: debugProxyFetchPatchInstalled ? false : undefined,
    auditContext: "openai-tts",
  });
  try {
    if (!debugProxyFetchPatchInstalled) {
      // Finalization retains capture failures; observe the Promise returned by the SDK view.
      void proxyCaptureSdk
        .captureHttpExchangeAsync({
          url: requestUrl,
          method: "POST",
          requestHeaders,
          requestBody,
          response,
          transport: "http",
          meta: {
            provider: "openai",
            capability: "tts",
          },
        })
        .catch(() => {});
    }

    await assertOkOrThrowProviderError(response, "OpenAI TTS API error");

    const audioBuffer = await readProviderBinaryResponse(
      response,
      "OpenAI TTS API error",
      "audio",
      {
        maxBytes,
        onOverflow: ({ maxBytes: maxBytesLocal }) =>
          new Error(`OpenAI TTS audio response exceeds ${maxBytesLocal} bytes`),
      },
    );
    return { audioBuffer, responseFormat };
  } finally {
    await release();
  }
}

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(resolveOpenAISpeechApiKey(normalizeOpenAIProviderConfig(providerConfig, "resolved")));
  return {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 10,
    defaultModel: OPENAI_TTS_MODELS[0],
    models: OPENAI_TTS_MODELS,
    voices: OPENAI_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeOpenAIProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeOpenAIProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenAISpeechResponseFormat(talkProviderConfig.responseFormat);
      const baseUrl = normalizeOptionalString(talkProviderConfig.baseUrl) ?? base.baseUrl;
      const speed = normalizeOpenAISpeechSpeed(talkProviderConfig.speed, baseUrl);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.openai.apiKey",
              }),
            }),
        baseUrl,
        model: normalizeOptionalString(talkProviderConfig.modelId) ?? base.model,
        voice: normalizeOptionalString(talkProviderConfig.voiceId) ?? base.voice,
        speed: speed ?? base.speed,
        instructions: normalizeOptionalString(talkProviderConfig.instructions) ?? base.instructions,
        responseFormat: responseFormat ?? base.responseFormat,
      };
    },
    resolveTalkOverrides: ({ params }) => {
      const voice = normalizeOptionalString(params.voiceId);
      const model = normalizeOptionalString(params.modelId);
      const speed = asFiniteNumber(params.speed);
      return {
        ...(voice ? { voice } : {}),
        ...(model ? { model } : {}),
        ...(speed == null ? {} : { speed }),
      };
    },
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const { audioBuffer, responseFormat } = await synthesizeOpenAISpeech(req);
      const fileExtension = `.${responseFormat}`;
      const { isVoiceMessageCompatibleAudio } = await import("openclaw/plugin-sdk/media-runtime");
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension,
        voiceCompatible:
          req.target === "voice-note" &&
          isVoiceMessageCompatibleAudio({ fileName: `speech${fileExtension}` }),
      };
    },
    synthesizeTelephony: async (req) => {
      const { audioBuffer } = await synthesizeOpenAISpeech({ ...req, target: "telephony" }, "pcm");
      return { audioBuffer, outputFormat: "pcm", sampleRate: 24_000 };
    },
  };
}
