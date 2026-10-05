import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription-session";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readAzureSpeechEnvApiKey,
  readAzureSpeechEnvRegion,
  resolveAzureSpeechConfigRecord,
} from "./config.js";
import { createAzureSpeechTranscriptionSession } from "./realtime-transcription-session.js";
import { DEFAULT_AZURE_SPEECH_LANG } from "./tts.js";

function resolveConfig(rawConfig: Record<string, unknown>, cfg?: OpenClawConfig) {
  const raw = resolveAzureSpeechConfigRecord(rawConfig) ?? rawConfig;
  const inherited = resolveAzureSpeechConfigRecord(cfg?.tts ?? {});
  const apiKey = normalizeResolvedSecretInputString({
    value: raw.apiKey ?? inherited?.apiKey,
    path:
      raw.apiKey !== undefined
        ? "plugins.entries.voice-call.config.streaming.providers.azure-speech.apiKey"
        : "tts.providers.azure-speech.apiKey",
  });
  return {
    ...(normalizeOptionalString(raw.model) ? { model: normalizeOptionalString(raw.model) } : {}),
    apiKey: apiKey ?? readAzureSpeechEnvApiKey(),
    region:
      normalizeOptionalString(raw.region) ??
      normalizeOptionalString(inherited?.region) ??
      readAzureSpeechEnvRegion(),
    language:
      normalizeOptionalString(raw.language ?? raw.lang) ??
      normalizeOptionalString(inherited?.lang) ??
      DEFAULT_AZURE_SPEECH_LANG,
  };
}

export function buildAzureSpeechTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "azure-speech",
    label: "Azure Speech Transcription",
    aliases: ["azure"],
    autoSelectOrder: Number.MAX_SAFE_INTEGER,
    resolveConfig: ({ cfg, rawConfig }) => resolveConfig(rawConfig, cfg),
    isConfigured: ({ cfg, providerConfig }) => {
      const config = resolveConfig(providerConfig, cfg);
      return Boolean(config.apiKey && config.region && /^[a-z0-9]+$/.test(config.region));
    },
    createSession: (request) => {
      const config = resolveConfig(request.providerConfig, request.cfg);
      if (!config.apiKey) {
        throw new Error("Azure Speech API key missing. Configure AZURE_SPEECH_KEY.");
      }
      if (!config.region || !/^[a-z0-9]+$/.test(config.region)) {
        throw new Error(
          "Azure Speech dictation requires a resource region, such as eastus. Configure AZURE_SPEECH_REGION.",
        );
      }
      if (normalizeOptionalString(request.providerConfig.model)) {
        throw new Error(
          "Azure Speech dictation uses the standard recognition model; remove the transcription model override.",
        );
      }
      return createAzureSpeechTranscriptionSession({
        ...request,
        apiKey: config.apiKey,
        region: config.region,
        language: config.language,
      });
    },
  };
}
