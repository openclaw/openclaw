import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import {
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
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

function readAzureSpeechEnvRegion(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_REGION) ?? trimToUndefined(process.env.SPEECH_REGION)
  );
}

function normalizeAzureSpeechProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw =
    asOptionalRecord(providers?.["azure-speech"]) ??
    asOptionalRecord(providers?.azure) ??
    asOptionalRecord(rawConfig["azure-speech"]) ??
    asOptionalRecord(rawConfig.azure);
  const region = trimToUndefined(raw?.region) ?? readAzureSpeechEnvRegion();
  const endpoint =
    trimToUndefined(raw?.endpoint) ?? trimToUndefined(process.env.AZURE_SPEECH_ENDPOINT);
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

function readAzureSpeechProviderConfig(config: SpeechProviderConfig) {
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

const parseDirectiveToken = createSpeechDirectiveParser({
  voice: [
    "allowVoice",
    ["voice", "voiceid", "voice_id", "azure_voice", "azurevoice", "azure_speech_voice"],
  ],
  lang: [
    "allowVoiceSettings",
    ["lang", "language", "language_code", "languagecode", "azure_lang", "azure_language"],
  ],
  outputFormat: [
    "allowVoiceSettings",
    ["output_format", "outputformat", "azure_format", "azure_output_format"],
  ],
});

function resolveApiKey(...candidates: Array<string | undefined>): string | undefined {
  return resolveSpeechProviderApiKey(
    ...candidates,
    trimToUndefined(process.env.AZURE_SPEECH_KEY) ??
      trimToUndefined(process.env.AZURE_SPEECH_API_KEY) ??
      trimToUndefined(process.env.SPEECH_KEY),
  );
}

async function resolveAzureSpeechTtsRequest(
  req: SpeechSynthesisRequest,
  outputFormatOverride?: string,
) {
  const config = readAzureSpeechProviderConfig(req.providerConfig);
  const overrides = req.providerOverrides;
  const voice = trimToUndefined(overrides?.voice ?? overrides?.voiceId);
  const lang = trimToUndefined(overrides?.lang ?? overrides?.languageCode);
  const outputFormat = trimToUndefined(overrides?.outputFormat);
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
    voice: voice ?? config.voice,
    lang: lang ?? config.lang,
    outputFormat:
      outputFormatOverride ??
      outputFormat ??
      (req.target === "voice-note" ? config.voiceNoteOutputFormat : config.outputFormat),
    timeoutMs: config.timeoutMs ?? req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  };
}

export function buildAzureSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) => {
    const config = readAzureSpeechProviderConfig(providerConfig);
    return Boolean(
      resolveApiKey(config.apiKey) && (config.baseUrl || config.region || config.endpoint),
    );
  };
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
        // Inherit the resolved route unless Talk explicitly selects another one.
        baseUrl:
          trimToUndefined(talkProviderConfig.baseUrl) ??
          (!region && !endpoint ? base.baseUrl : undefined),
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
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
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
