import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
import { azureSpeechTTS } from "./tts.js";

const DEFAULT_AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

type AzureProviderConfig = {
  apiKey?: string;
  region: string;
  baseUrl: string;
  voice: string;
  lang: string;
  outputFormat: string;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeAzureBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeAzureProviderConfig(
  rawConfig: Record<string, unknown>,
): AzureProviderConfig {
  const providers = asObject(rawConfig.providers);
  const rawAzure = asObject(providers?.["azure-speech"]) ?? asObject(rawConfig["azure-speech"]);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: rawAzure?.apiKey,
      path: "messages.tts.providers.azure-speech.apiKey",
    }),
    region: trimToUndefined(rawAzure?.region) ?? process.env.AZURE_SPEECH_REGION ?? "eastus",
    baseUrl: normalizeAzureBaseUrl(trimToUndefined(rawAzure?.baseUrl)),
    voice: trimToUndefined(rawAzure?.voice) ?? "",
    lang: trimToUndefined(rawAzure?.lang) ?? "en-US",
    outputFormat: trimToUndefined(rawAzure?.outputFormat) ?? DEFAULT_AZURE_OUTPUT_FORMAT,
  };
}

function readAzureProviderConfig(config: SpeechProviderConfig): AzureProviderConfig {
  const defaults = normalizeAzureProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    region: trimToUndefined(config.region) ?? defaults.region,
    baseUrl: trimToUndefined(config.baseUrl) ?? defaults.baseUrl,
    voice: trimToUndefined(config.voice) ?? defaults.voice,
    lang: trimToUndefined(config.lang) ?? defaults.lang,
    outputFormat: trimToUndefined(config.outputFormat) ?? defaults.outputFormat,
  };
}

export function buildAzureSpeechProviderPlugin(): SpeechProviderPlugin {
  return {
    id: "azure-speech",
    label: "Azure Speech",
    aliases: ["azure", "azure-tts"],
    listVoices: async (req) => {
      const config = readAzureProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }
      const { listAzureVoices } = await import("./tts.js");
      return listAzureVoices({
        apiKey,
        region: req.providerConfig.region as string | undefined ?? config.region,
        baseUrl: req.baseUrl ?? config.baseUrl || undefined,
        timeoutMs: req.timeoutMs,
      });
    },
    isConfigured: ({ providerConfig }) => {
      const config = readAzureProviderConfig(providerConfig);
      const hasApiKey = Boolean(config.apiKey || process.env.AZURE_SPEECH_API_KEY);
      const hasVoice = Boolean(config.voice);
      return hasApiKey && hasVoice;
    },
    resolveProviderConfig: ({ params }) => ({
      apiKey: trimToUndefined(params.apiKey),
      region: trimToUndefined(params.region),
      baseUrl: trimToUndefined(params.baseUrl),
      voice: trimToUndefined(params.voice),
      lang: trimToUndefined(params.lang),
      outputFormat: trimToUndefined(params.outputFormat),
    }),
    resolveProviderOverrides: ({ params }) => {
      const overrides: Record<string, unknown> = {};
      if (params.voiceId) overrides.voice = params.voiceId;
      if (params.outputFormat) overrides.outputFormat = params.outputFormat;
      return Object.keys(overrides).length > 0 ? overrides : undefined;
    },
    synthesize: async (req) => {
      const config = readAzureProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.AZURE_SPEECH_API_KEY;
      if (!apiKey) {
        throw new Error("Azure Speech API key missing");
      }

      const region =
        (req.providerConfig.region as string | undefined) ?? config.region;
      const baseUrl = (req.providerConfig.baseUrl as string | undefined) ?? config.baseUrl || undefined;
      const voice =
        (req.providerOverrides as Record<string, unknown>)?.voice as string | undefined ??
        config.voice;
      const lang =
        (req.providerOverrides as Record<string, unknown>)?.lang as string | undefined ??
        config.lang;
      const outputFormat =
        (req.providerOverrides as Record<string, unknown>)?.outputFormat as string | undefined ??
        config.outputFormat;

      if (!voice) {
        throw new Error(
          "Azure voice not configured. Set voice in config or use [[tts:voice_id=zh-HK-HiuMaanNeural]] directive",
        );
      }

      const result = await azureSpeechTTS({
        text: req.text,
        apiKey,
        region,
        baseUrl,
        voice,
        lang,
        outputFormat,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer: result.audioBuffer,
        outputFormat,
        fileExtension: result.fileExtension,
        voiceCompatible: result.voiceCompatible,
      };
    },
  };
}