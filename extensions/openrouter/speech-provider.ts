import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";
import { collectStreamedAudio } from "./streaming-audio.js";

const OPENROUTER_SPEECH_MODELS = [
  "openai/gpt-audio",
  "openai/gpt-audio-mini",
  "openai/gpt-4o-audio-preview",
] as const;
const OPENROUTER_SPEECH_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;
const DEFAULT_TIMEOUT_MS = 60_000;

type OpenRouterSpeechConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
};

function readConfig(providerConfig: Record<string, unknown>): OpenRouterSpeechConfig {
  return {
    apiKey: normalizeOptionalString(providerConfig.apiKey),
    baseUrl: normalizeOptionalString(providerConfig.baseUrl),
    model: normalizeOptionalString(providerConfig.model),
    voice: normalizeOptionalString(providerConfig.voice),
    format: normalizeOptionalString(providerConfig.format),
  };
}

function resolveResponseFormat(
  target: "audio-file" | "voice-note",
  configuredFormat?: string,
): { format: string; mimeType: string; fileExtension: string } {
  if (configuredFormat === "wav") {
    return { format: "wav", mimeType: "audio/wav", fileExtension: ".wav" };
  }
  if (configuredFormat === "opus" || target === "voice-note") {
    return { format: "opus", mimeType: "audio/ogg", fileExtension: ".opus" };
  }
  return { format: "mp3", mimeType: "audio/mpeg", fileExtension: ".mp3" };
}

export function buildOpenrouterSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openrouter",
    label: "OpenRouter",
    models: [...OPENROUTER_SPEECH_MODELS],
    voices: [...OPENROUTER_SPEECH_VOICES],
    listVoices: async () =>
      OPENROUTER_SPEECH_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) => {
      const config = readConfig(providerConfig);
      return Boolean(config.apiKey || process.env.OPENROUTER_API_KEY);
    },
    async synthesize(req) {
      const config = readConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OpenRouter API key missing for speech synthesis");
      }

      const { baseUrl, headers } = resolveProviderHttpRequestConfig({
        baseUrl: resolveConfiguredBaseUrl(req.cfg) ?? config.baseUrl,
        defaultBaseUrl: OPENROUTER_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
        },
        provider: "openrouter",
        capability: "audio",
        transport: "http",
      });

      const model = config.model ?? "openai/gpt-audio-mini";
      const voice = config.voice ?? "alloy";
      const { format, mimeType, fileExtension } = resolveResponseFormat(
        req.target,
        config.format,
      );

      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      const response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: req.text }],
            modalities: ["text", "audio"],
            audio: { voice, format },
            stream: true,
          }),
        },
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetch,
      );
      await assertOkOrThrowHttpError(response, "OpenRouter speech synthesis failed");

      const { audioBuffer } = await collectStreamedAudio(response);
      if (audioBuffer.length === 0) {
        throw new Error("OpenRouter speech synthesis response missing audio data");
      }

      return {
        audioBuffer,
        outputFormat: mimeType,
        fileExtension,
        voiceCompatible: req.target === "voice-note" && format === "opus",
      };
    },
  };
}
