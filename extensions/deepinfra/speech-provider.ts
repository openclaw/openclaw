import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asObject,
  trimToUndefined,
  type SpeechDirectiveTokenParseContext,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_TTS_MODELS,
  DEFAULT_DEEPINFRA_TTS_MODEL,
  DEFAULT_DEEPINFRA_TTS_VOICE,
  normalizeDeepInfraBaseUrl,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

const DEEPINFRA_TTS_RESPONSE_FORMATS = ["mp3", "opus", "flac", "wav", "pcm"] as const;

type DeepInfraTtsResponseFormat = (typeof DEEPINFRA_TTS_RESPONSE_FORMATS)[number];

type DeepInfraTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat?: DeepInfraTtsResponseFormat;
  extraBody?: Record<string, unknown>;
};

type DeepInfraTtsProviderOverrides = {
  model?: string;
  voice?: string;
  speed?: number;
};

function normalizeDeepInfraTtsResponseFormat(
  value: unknown,
): DeepInfraTtsResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  if (DEEPINFRA_TTS_RESPONSE_FORMATS.some((format) => format === next)) {
    return next as DeepInfraTtsResponseFormat;
  }
  throw new Error(`Invalid DeepInfra speech responseFormat: ${next}`);
}

function resolveDeepInfraProviderConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.deepinfra) ?? asObject(rawConfig.deepinfra);
}

function normalizeDeepInfraTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): DeepInfraTtsProviderConfig {
  const raw = resolveDeepInfraProviderConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.deepinfra.apiKey",
    }),
    baseUrl:
      trimToUndefined(raw?.baseUrl) == null ? undefined : normalizeDeepInfraBaseUrl(raw?.baseUrl),
    model: normalizeDeepInfraModelRef(
      trimToUndefined(raw?.model ?? raw?.modelId),
      DEFAULT_DEEPINFRA_TTS_MODEL,
    ),
    voice: trimToUndefined(raw?.voice ?? raw?.voiceId) ?? DEFAULT_DEEPINFRA_TTS_VOICE,
    speed: asFiniteNumber(raw?.speed),
    responseFormat: normalizeDeepInfraTtsResponseFormat(raw?.responseFormat),
    extraBody: asObject(raw?.extraBody),
  };
}

function readDeepInfraTtsProviderConfig(config: SpeechProviderConfig): DeepInfraTtsProviderConfig {
  const normalized = normalizeDeepInfraTtsProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl:
      trimToUndefined(config.baseUrl) == null
        ? normalized.baseUrl
        : normalizeDeepInfraBaseUrl(config.baseUrl),
    model: normalizeDeepInfraModelRef(
      trimToUndefined(config.model ?? config.modelId),
      normalized.model,
    ),
    voice: trimToUndefined(config.voice ?? config.voiceId) ?? normalized.voice,
    speed: asFiniteNumber(config.speed) ?? normalized.speed,
    responseFormat:
      normalizeDeepInfraTtsResponseFormat(config.responseFormat) ?? normalized.responseFormat,
    extraBody: asObject(config.extraBody) ?? normalized.extraBody,
  };
}

function readDeepInfraTtsOverrides(
  overrides: SpeechProviderOverrides | undefined,
): DeepInfraTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model ?? overrides.modelId),
    voice: trimToUndefined(overrides.voice ?? overrides.voiceId),
    speed: asFiniteNumber(overrides.speed),
  };
}

function resolveDeepInfraTtsApiKey(params: {
  cfg?: { models?: { providers?: { deepinfra?: { apiKey?: unknown } } } };
  providerConfig: DeepInfraTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.apiKey ??
    normalizeResolvedSecretInputString({
      value: params.cfg?.models?.providers?.deepinfra?.apiKey,
      path: "models.providers.deepinfra.apiKey",
    }) ??
    trimToUndefined(process.env.DEEPINFRA_API_KEY)
  );
}

function resolveDeepInfraTtsBaseUrl(params: {
  cfg?: { models?: { providers?: { deepinfra?: { baseUrl?: unknown } } } };
  providerConfig: DeepInfraTtsProviderConfig;
}): string {
  return normalizeDeepInfraBaseUrl(
    params.providerConfig.baseUrl ??
      trimToUndefined(params.cfg?.models?.providers?.deepinfra?.baseUrl) ??
      DEEPINFRA_BASE_URL,
  );
}

function responseFormatToFileExtension(
  format: DeepInfraTtsResponseFormat,
): ".mp3" | ".opus" | ".flac" | ".wav" | ".pcm" {
  return `.${format}`;
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
} {
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case "deepinfra_voice":
    case "deepinfravoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "model":
    case "model_id":
    case "modelid":
    case "deepinfra_model":
    case "deepinframodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildDeepInfraSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "deepinfra",
    label: "DeepInfra",
    autoSelectOrder: 45,
    models: [...DEEPINFRA_TTS_MODELS],
    voices: [DEFAULT_DEEPINFRA_TTS_VOICE],
    resolveConfig: ({ rawConfig }) => normalizeDeepInfraTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeDeepInfraTtsProviderConfig(baseTtsConfig);
      const responseFormat = normalizeDeepInfraTtsResponseFormat(talkProviderConfig.responseFormat);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.deepinfra.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeDeepInfraBaseUrl(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : {
              model: normalizeDeepInfraModelRef(
                trimToUndefined(talkProviderConfig.modelId),
                DEFAULT_DEEPINFRA_TTS_MODEL,
              ),
            }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId ?? params.voice) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId ?? params.voice) }),
      ...(trimToUndefined(params.modelId ?? params.model) == null
        ? {}
        : { model: trimToUndefined(params.modelId ?? params.model) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
    }),
    listVoices: async () => [
      { id: DEFAULT_DEEPINFRA_TTS_VOICE, name: DEFAULT_DEEPINFRA_TTS_VOICE },
    ],
    isConfigured: ({ cfg, providerConfig }) => {
      const config = readDeepInfraTtsProviderConfig(providerConfig);
      return Boolean(resolveDeepInfraTtsApiKey({ cfg, providerConfig: config }));
    },
    synthesize: async (req) => {
      const config = readDeepInfraTtsProviderConfig(req.providerConfig);
      const overrides = readDeepInfraTtsOverrides(req.providerOverrides);
      const apiKey = resolveDeepInfraTtsApiKey({ cfg: req.cfg, providerConfig: config });
      if (!apiKey) {
        throw new Error("DeepInfra API key missing");
      }

      const baseUrl = resolveDeepInfraTtsBaseUrl({ cfg: req.cfg, providerConfig: config });
      const responseFormat = config.responseFormat ?? "mp3";
      const speed = overrides.speed ?? config.speed;
      const { allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: DEEPINFRA_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        provider: "deepinfra",
        capability: "audio",
        transport: "http",
      });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/audio/speech`,
        headers,
        body: {
          model: normalizeDeepInfraModelRef(
            overrides.model ?? config.model,
            DEFAULT_DEEPINFRA_TTS_MODEL,
          ),
          input: req.text,
          voice: overrides.voice ?? config.voice,
          response_format: responseFormat,
          ...(speed == null ? {} : { speed }),
          ...(config.extraBody == null ? {} : { extra_body: config.extraBody }),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "DeepInfra TTS API error");
        return {
          audioBuffer: Buffer.from(await response.arrayBuffer()),
          outputFormat: responseFormat,
          fileExtension: responseFormatToFileExtension(responseFormat),
          voiceCompatible: responseFormat === "mp3" || responseFormat === "opus",
        };
      } finally {
        await release();
      }
    },
  };
}
