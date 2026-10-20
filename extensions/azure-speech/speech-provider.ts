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

const DEFAULT_AZURE_SPEECH_VOICE = "en-US-JennyNeural";
const DEFAULT_AZURE_SPEECH_LANG = "en-US";
const DEFAULT_AZURE_SPEECH_AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT = "ogg-24khz-16bit-mono-opus";
const DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT = "raw-8khz-8bit-mono-mulaw";
// Voice discovery should fail boundedly instead of waiting forever when the
// Azure Speech voices endpoint accepts the connection but never responds.
const DEFAULT_AZURE_SPEECH_VOICE_LIST_TIMEOUT_MS = 30_000;
const AZURE_SPEECH_FILE_EXTENSIONS = [
  ["ogg-", ".ogg"],
  ["webm-", ".webm"],
  ["riff-", ".wav"],
  ["raw-", ".pcm"],
  ["amr-", ".amr"],
] as const;

function normalizeAzureSpeechBaseUrl(params: {
  baseUrl?: string;
  endpoint?: string;
  region?: string;
}): string | undefined {
  const configured = trimToUndefined(params.baseUrl) ?? trimToUndefined(params.endpoint);
  if (configured) {
    return configured.replace(/\/+$/, "").replace(/\/cognitiveservices\/v1$/i, "");
  }
  const region = trimToUndefined(params.region);
  return region ? `https://${region}.tts.speech.microsoft.com` : undefined;
}

function azureSpeechUrl(params: {
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  path: "/cognitiveservices/v1" | "/cognitiveservices/voices/list";
}): string {
  const baseUrl = normalizeAzureSpeechBaseUrl(params);
  if (!baseUrl) {
    throw new Error("Azure Speech region or endpoint missing");
  }
  return `${baseUrl}${params.path}`;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildAzureSpeechSsml(params: { text: string; voice: string; lang: string }): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xml:lang="${escapeXmlAttr(params.lang)}">` +
    `<voice name="${escapeXmlAttr(params.voice)}">${escapeXmlText(params.text)}</voice>` +
    `</speak>`
  );
}

function inferAzureSpeechFileExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("mp3")) {
    return ".mp3";
  }
  return (
    AZURE_SPEECH_FILE_EXTENSIONS.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? ".audio"
  );
}

function isAzureSpeechVoiceCompatible(outputFormat: string): boolean {
  const normalized = outputFormat.toLowerCase();
  return normalized.startsWith("ogg-") && normalized.includes("opus");
}

function readAzureVoiceTagStrings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => trimToUndefined(entry) !== undefined)
    : undefined;
}

function isDeprecatedVoice(entry: Record<string, unknown>): boolean {
  if (entry.IsDeprecated === true) {
    return true;
  }
  if (typeof entry.IsDeprecated === "string" && entry.IsDeprecated.toLowerCase() === "true") {
    return true;
  }
  const status = trimToUndefined(entry.Status)?.toLowerCase();
  return status === "deprecated" || status === "retired" || status === "disabled";
}

async function azureSpeechTTS(req: SpeechSynthesisRequest, outputFormatOverride?: string) {
  const config = readAzureSpeechProviderConfig(req.providerConfig);
  const overrides = req.providerOverrides;
  const voiceOverride = trimToUndefined(overrides?.voice ?? overrides?.voiceId);
  const lang = trimToUndefined(overrides?.lang ?? overrides?.languageCode) ?? config.lang;
  const formatOverride = trimToUndefined(overrides?.outputFormat);
  const apiKey = resolveApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Azure Speech API key missing");
  }
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const text = req.text;
  const requestedOutputFormat =
    outputFormatOverride ??
    formatOverride ??
    (req.target === "voice-note" ? config.voiceNoteOutputFormat : config.outputFormat);
  const timeoutMs = config.timeoutMs ?? req.timeoutMs;
  const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");
  const voice = voiceOverride ?? config.voice;
  const outputFormat = requestedOutputFormat;
  const url = azureSpeechUrl({ ...config, path: "/cognitiveservices/v1" });
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "Ocp-Apim-Subscription-Key": apiKey,
        "X-Microsoft-OutputFormat": outputFormat,
        "User-Agent": "OpenClaw",
      },
      body: buildAzureSpeechSsml({
        text,
        voice,
        lang,
      }),
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
    auditContext: "azure-speech.tts",
  });

  try {
    await assertOkOrThrowProviderError(response, "Azure Speech TTS API error");
    return {
      audioBuffer: await readProviderBinaryResponse(
        response,
        "Azure Speech TTS API error",
        "audio",
        {
          maxBytes,
          onOverflow: ({ maxBytes: limit }) =>
            new Error(`Azure Speech TTS audio response exceeds ${limit} bytes`),
        },
      ),
      outputFormat: requestedOutputFormat,
    };
  } finally {
    await release();
  }
}

function readAzureSpeechEnvRegion(): string | undefined {
  return (
    trimToUndefined(process.env.AZURE_SPEECH_REGION) ?? trimToUndefined(process.env.SPEECH_REGION)
  );
}

function normalizeAzureSpeechFields(
  raw: Record<string, unknown> | undefined,
  apiKey: string | undefined,
) {
  const configuredRegion = trimToUndefined(raw?.region);
  const region = configuredRegion ?? readAzureSpeechEnvRegion();
  const endpoint =
    trimToUndefined(raw?.endpoint) ??
    (configuredRegion ? undefined : trimToUndefined(process.env.AZURE_SPEECH_ENDPOINT));
  const baseUrl = normalizeAzureSpeechBaseUrl({
    baseUrl: trimToUndefined(raw?.baseUrl),
    endpoint,
    region,
  });
  return {
    apiKey,
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

function normalizeAzureSpeechProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.["azure-speech"]) ?? asOptionalRecord(providers?.azure);
  return normalizeAzureSpeechFields(
    raw,
    normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.azure-speech.apiKey",
    }),
  );
}

function readAzureSpeechProviderConfig(config: SpeechProviderConfig) {
  return normalizeAzureSpeechFields(config, trimToUndefined(config.apiKey));
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
      const url = azureSpeechUrl({
        baseUrl: req.baseUrl ?? config?.baseUrl,
        endpoint: config?.endpoint,
        region: config?.region ?? readAzureSpeechEnvRegion(),
        path: "/cognitiveservices/voices/list",
      });
      const timeoutMs = config?.timeoutMs ?? req.timeoutMs;
      const { assertOkOrThrowProviderError, readProviderJsonResponse } =
        await import("openclaw/plugin-sdk/provider-http");
      const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
        await import("openclaw/plugin-sdk/ssrf-runtime");
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: {
          method: "GET",
          headers: { "Ocp-Apim-Subscription-Key": apiKey },
        },
        timeoutMs: timeoutMs ?? DEFAULT_AZURE_SPEECH_VOICE_LIST_TIMEOUT_MS,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
        auditContext: "azure-speech.voices",
      });

      try {
        await assertOkOrThrowProviderError(response, "Azure Speech voices API error");
        const voices = await readProviderJsonResponse<unknown>(response, "azure-speech.voices");
        return Array.isArray(voices)
          ? voices.flatMap((value) => {
              const voice = asOptionalRecord(value);
              const id = trimToUndefined(voice?.ShortName);
              if (!voice || !id || isDeprecatedVoice(voice)) {
                return [];
              }
              const voiceTag = asOptionalRecord(voice.VoiceTag);
              const tailoredScenarios = readAzureVoiceTagStrings(voiceTag?.TailoredScenarios);
              const personalities = readAzureVoiceTagStrings(voiceTag?.VoicePersonalities);
              const description = [...(tailoredScenarios ?? []), ...(personalities ?? [])];
              return [
                {
                  id,
                  name: trimToUndefined(voice.DisplayName) ?? trimToUndefined(voice.LocalName),
                  description: description.length > 0 ? description.join(", ") : undefined,
                  locale: trimToUndefined(voice.Locale),
                  gender: trimToUndefined(voice.Gender),
                  personalities,
                },
              ];
            })
          : [];
      } finally {
        await release();
      }
    },
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const { audioBuffer, outputFormat } = await azureSpeechTTS(req);
      return {
        audioBuffer,
        outputFormat,
        fileExtension: inferAzureSpeechFileExtension(outputFormat),
        voiceCompatible: isAzureSpeechVoiceCompatible(outputFormat),
      };
    },
    synthesizeTelephony: async (req) => {
      const { audioBuffer } = await azureSpeechTTS(
        { ...req, target: "telephony" },
        DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
      );
      return {
        audioBuffer,
        outputFormat: DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
        sampleRate: 8_000,
      };
    },
  };
}
