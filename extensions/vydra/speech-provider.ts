import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_VYDRA_BASE_URL,
  DEFAULT_VYDRA_SPEECH_MODEL,
  DEFAULT_VYDRA_VOICE_ID,
  normalizeVydraBaseUrl,
} from "./defaults.js";

const VYDRA_SPEECH_VOICES = [
  {
    id: DEFAULT_VYDRA_VOICE_ID,
    name: "Rachel",
  },
] as const;

function normalizeVydraSpeechConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.vydra);
  const apiKey = normalizeResolvedSecretInputString({
    value: raw?.apiKey,
    path: "tts.providers.vydra.apiKey",
  });
  return {
    ...readVydraSpeechConfig(raw ?? {}),
    apiKey,
  };
}

function readVydraSpeechConfig(config: SpeechProviderConfig) {
  return {
    apiKey: normalizeOptionalString(config.apiKey),
    baseUrl: normalizeVydraBaseUrl(
      normalizeOptionalString(config.baseUrl) ??
        normalizeOptionalString(process.env.VYDRA_BASE_URL),
    ),
    model:
      normalizeOptionalString(config.model) ??
      normalizeOptionalString(process.env.VYDRA_TTS_MODEL) ??
      DEFAULT_VYDRA_SPEECH_MODEL,
    voiceId:
      normalizeOptionalString(config.voiceId) ??
      normalizeOptionalString(process.env.VYDRA_TTS_VOICE_ID) ??
      DEFAULT_VYDRA_VOICE_ID,
  };
}

export function buildVydraSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    Boolean(
      resolveSpeechProviderApiKey(
        readVydraSpeechConfig(providerConfig).apiKey,
        process.env.VYDRA_API_KEY,
      ),
    );
  return {
    id: "vydra",
    label: "Vydra",
    models: [DEFAULT_VYDRA_SPEECH_MODEL],
    voices: VYDRA_SPEECH_VOICES.map((voice) => voice.id),
    resolveConfig: ({ rawConfig }) => normalizeVydraSpeechConfig(rawConfig),
    listVoices: async () => VYDRA_SPEECH_VOICES.map((voice) => Object.assign({}, voice)),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const { downloadVydraAsset, extractVydraResultUrls } = await import("./shared.js");
      const config = readVydraSpeechConfig(req.providerConfig);
      const overrides = req.providerOverrides;
      const apiKey = resolveSpeechProviderApiKey(config.apiKey, process.env.VYDRA_API_KEY);
      if (!apiKey) {
        throw new Error("Vydra API key missing");
      }
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const { postJsonResponse, resolveProviderHttpRequestConfig } =
        await import("openclaw/plugin-sdk/provider-http");

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: config.baseUrl,
          defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "vydra",
          capability: "audio",
          transport: "http",
        });

      const payload = await postJsonResponse<unknown>({
        url: `${baseUrl}/models/${normalizeOptionalString(overrides?.model) ?? config.model}`,
        headers,
        body: {
          text: req.text,
          voice_id: normalizeOptionalString(overrides?.voiceId) ?? config.voiceId,
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        errorLabel: "Vydra speech synthesis failed",
        responseLabel: "Vydra speech synthesis",
      });
      const audioUrl = extractVydraResultUrls(payload, "audio")[0];
      if (!audioUrl) {
        throw new Error("Vydra speech synthesis response missing audio URL");
      }
      const audio = await downloadVydraAsset({
        url: audioUrl,
        kind: "audio",
        timeoutMs: req.timeoutMs,
        fetchFn,
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
        requestPolicy: {
          allowPrivateNetwork,
          dispatcherPolicy,
          headers,
          headerOrigin: new URL(baseUrl).origin,
        },
      });
      return {
        audioBuffer: audio.buffer,
        outputFormat: audio.mimeType.includes("wav") ? "wav" : "mp3",
        fileExtension: audio.fileName.endsWith(".wav") ? ".wav" : ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
