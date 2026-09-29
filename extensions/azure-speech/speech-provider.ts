import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumber,
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  azureSpeechTTS,
  DEFAULT_AZURE_SPEECH_AUDIO_FORMAT,
  DEFAULT_AZURE_SPEECH_LANG,
  DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
  DEFAULT_AZURE_SPEECH_VOICE,
  DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT,
  inferAzureSpeechFileExtension,
  isAzureSpeechVoiceCompatible,
  listAzureSpeechVoices,
  normalizeAzureSpeechBaseUrl,
} from "./tts.js";

type AzureSpeechProviderConfig = {
  apiKey?: string;
  region?: string;
  endpoint?: string;
  baseUrl?: string;
  voice: string;
  lang: string;
  outputFormat: string;
  voiceNoteOutputFormat: string;
  timeoutMs?: number;
};

type AzureSpeechProviderOverrides = {
  voice?: string;
  lang?: string;
  outputFormat?: string;
};

function readAzureSpeechEnvApiKey(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_KEY) ??
    trimToUndefined(process.env.AZURE_SPEECH_API_KEY) ??
    trimToUndefined(process.env.SPEECH_KEY)
  );
}

function readAzureSpeechEnvRegion(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_REGION) ?? trimToUndefined(process.env.SPEECH_REGION)
  );
}

function readAzureSpeechEnvEndpoint(): string | undefined {
  return trimToUndefined(process.env.AZURE_SPEECH_ENDPOINT);
}

function resolveAzureSpeechConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(rawConfig.providers);
  return (
    asOptionalRecord(providers?.["azure-speech"]) ??
    asOptionalRecord(providers?.azure) ??
    asOptionalRecord(rawConfig["azure-speech"]) ??
    asOptionalRecord(rawConfig.azure)
  );
}

function normalizeAzureSpeechProviderConfig(
  rawConfig: Record<string, unknown>,
): AzureSpeechProviderConfig {
  const raw = resolveAzureSpeechConfigRecord(rawConfig);
  const region = trimToUndefined(raw?.region) ?? readAzureSpeechEnvRegion();
  const endpoint = trimToUndefined(raw?.endpoint) ?? readAzureSpeechEnvEndpoint();
  const baseUrl = normalizeAzureSpeechBaseUrl({
    baseUrl: trimToUndefined(raw?.baseUrl),
    endpoint,
    region,
  });
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.azure-speech.apiKey",
    }),
    region,
    endpoint,
    baseUrl,
    voice: trimToUndefined(raw?.voice ?? raw?.voiceId) ?? DEFAULT_AZURE_SPEECH_VOICE,
    lang: trimToUndefined(raw?.lang ?? raw?.languageCode) ?? DEFAULT_AZURE_SPEECH_LANG,
    outputFormat: trimToUndefined(raw?.outputFormat) ?? DEFAULT_AZURE_SPEECH_AUDIO_FORMAT,
    voiceNoteOutputFormat:
      trimToUndefined(raw?.voiceNoteOutputFormat) ?? DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT,
    timeoutMs: asFiniteNumber(raw?.timeoutMs),
  };
}

function readAzureSpeechProviderConfig(config: SpeechProviderConfig): AzureSpeechProviderConfig {
  const defaults = normalizeAzureSpeechProviderConfig({});
  const region = trimToUndefined(config.region) ?? defaults.region;
  const endpoint = trimToUndefined(config.endpoint) ?? defaults.endpoint;
  const baseUrl = normalizeAzureSpeechBaseUrl({
    baseUrl: trimToUndefined(config.baseUrl) ?? defaults.baseUrl,
    endpoint,
    region,
  });
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    region,
    endpoint,
    baseUrl,
    voice: trimToUndefined(config.voice ?? config.voiceId) ?? defaults.voice,
    lang: trimToUndefined(config.lang ?? config.languageCode) ?? defaults.lang,
    outputFormat: trimToUndefined(config.outputFormat) ?? defaults.outputFormat,
    voiceNoteOutputFormat:
      trimToUndefined(config.voiceNoteOutputFormat) ?? defaults.voiceNoteOutputFormat,
    timeoutMs: asFiniteNumber(config.timeoutMs) ?? defaults.timeoutMs,
  };
}

function readAzureSpeechOverrides(
  overrides: SpeechProviderOverrides | undefined,
): AzureSpeechProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voice: trimToUndefined(overrides.voice ?? overrides.voiceId),
    lang: trimToUndefined(overrides.lang ?? overrides.languageCode),
    outputFormat: trimToUndefined(overrides.outputFormat),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
} {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "azure_voice":
    case "azurevoice":
    case "azure_speech_voice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, voice: ctx.value } };
    case "lang":
    case "language":
    case "language_code":
    case "languagecode":
    case "azure_lang":
    case "azure_language":
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, lang: ctx.value } };
    case "output_format":
    case "outputformat":
    case "azure_format":
    case "azure_output_format":
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, outputFormat: ctx.value } };
    default:
      return { handled: false };
  }
}

function resolveApiKey(...candidates: Array<string | undefined>): string | undefined {
  return resolveSpeechProviderApiKey(...candidates, readAzureSpeechEnvApiKey());
}

async function resolveAzureSpeechTtsRequest(
  req: SpeechSynthesisRequest,
  outputFormatOverride?: string,
) {
  const config = readAzureSpeechProviderConfig(req.providerConfig);
  const overrides = readAzureSpeechOverrides(req.providerOverrides);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Azure Speech API key missing");
  }
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    region: config.region,
    voice: overrides.voice ?? config.voice,
    lang: overrides.lang ?? config.lang,
    outputFormat:
      outputFormatOverride ??
      overrides.outputFormat ??
      (req.target === "voice-note" ? config.voiceNoteOutputFormat : config.outputFormat),
    timeoutMs: config.timeoutMs ?? req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  };
}

export function buildAzureSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "azure-speech",
    label: "Azure Speech",
    aliases: ["azure"],
    autoSelectOrder: 30,
    resolveConfig: ({ rawConfig }) => normalizeAzureSpeechProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeAzureSpeechProviderConfig(baseTtsConfig);
      const apiKey =
        talkProviderConfig.apiKey === undefined
          ? undefined
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.azure-speech.apiKey",
            });
      const region = trimToUndefined(talkProviderConfig.region);
      const endpoint = trimToUndefined(talkProviderConfig.endpoint ?? talkProviderConfig.baseUrl);
      const baseUrl = normalizeAzureSpeechBaseUrl({
        baseUrl: trimToUndefined(talkProviderConfig.baseUrl),
        endpoint,
        region: region ?? base.region,
      });
      return {
        ...base,
        ...filterStringRecord({
          apiKey,
          region,
          endpoint,
          baseUrl,
          voice: trimToUndefined(talkProviderConfig.voiceId),
          lang: trimToUndefined(talkProviderConfig.languageCode),
          outputFormat: trimToUndefined(talkProviderConfig.outputFormat),
        }),
      };
    },
    resolveTalkOverrides: ({ params }) =>
      filterStringRecord({
        voice: trimToUndefined(params.voiceId),
        lang: trimToUndefined(params.languageCode),
        outputFormat: trimToUndefined(params.outputFormat),
      }) ?? {},
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readAzureSpeechProviderConfig(req.providerConfig)
        : undefined;
      const apiKey = resolveApiKey(req.apiKey, config?.apiKey);
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }
      return listAzureSpeechVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
        endpoint: config?.endpoint,
        region: config?.region ?? readAzureSpeechEnvRegion(),
        timeoutMs: config?.timeoutMs ?? req.timeoutMs,
      });
    },
    isConfigured: ({ providerConfig }) => {
      const config = readAzureSpeechProviderConfig(providerConfig);
      return Boolean(
        resolveApiKey(config.apiKey) && (config.baseUrl || config.region || config.endpoint),
      );
    },
    synthesize: async (req) => {
      const params = await resolveAzureSpeechTtsRequest(req);
      const audioBuffer = await azureSpeechTTS(params);
      const outputFormat = params.outputFormat;
      return {
        audioBuffer,
        outputFormat,
        fileExtension: inferAzureSpeechFileExtension(outputFormat),
        voiceCompatible: isAzureSpeechVoiceCompatible(outputFormat),
      };
    },
    synthesizeTelephony: async (req) => {
      const params = await resolveAzureSpeechTtsRequest(
        { ...req, target: "telephony" },
        DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
      );
      const audioBuffer = await azureSpeechTTS(params);
      return {
        audioBuffer,
        outputFormat: DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
        sampleRate: 8_000,
      };
    },
  };
}
