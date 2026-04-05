import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { DEFAULT_INWORLD_BASE_URL, INWORLD_TTS_MODELS, inworldTTS } from "./tts.js";

type InworldTtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  modelId?: string;
  voiceId?: string;
};

type InworldTtsProviderOverrides = {
  voiceId?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeInworldBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_INWORLD_BASE_URL;
}

function normalizeInworldProviderConfig(
  rawConfig: Record<string, unknown>,
): InworldTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  // silent legacy tolerance for rawConfig.inworld — no docs/tests for this path
  const raw = asObject(providers?.inworld) ?? asObject(rawConfig.inworld);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.inworld.apiKey",
    }),
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(raw?.baseUrl)),
    modelId: trimToUndefined(raw?.modelId),
    voiceId: trimToUndefined(raw?.voiceId),
  };
}

function readInworldProviderConfig(config: SpeechProviderConfig): InworldTtsProviderConfig {
  const defaults = normalizeInworldProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
  };
}

function readInworldOverrides(
  overrides: SpeechProviderOverrides | undefined,
): InworldTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: trimToUndefined(overrides.voiceId),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voiceid":
    case "voice_id":
    case "inworld_voice":
    case "inworldvoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return {
        handled: true,
        overrides: { ...(ctx.currentOverrides ?? {}), voiceId: ctx.value },
      };
    default:
      return { handled: false };
  }
}

export function buildInworldSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "inworld",
    label: "Inworld",
    autoSelectOrder: 50,
    models: INWORLD_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeInworldProviderConfig(rawConfig),
    parseDirectiveToken,
    isConfigured: ({ providerConfig }) => {
      const config = readInworldProviderConfig(providerConfig);
      const hasApiKey = Boolean(config.apiKey || process.env.INWORLD_API_KEY);
      return hasApiKey && Boolean(config.modelId) && Boolean(config.voiceId);
    },
    synthesize: async (req) => {
      const config = readInworldProviderConfig(req.providerConfig);
      const overrides = readInworldOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.INWORLD_API_KEY;
      if (!apiKey) {
        throw new Error("Inworld API key missing");
      }
      const modelId = config.modelId;
      if (!modelId) {
        throw new Error("Inworld modelId missing — set messages.tts.providers.inworld.modelId");
      }
      const voiceId = overrides.voiceId ?? config.voiceId;
      if (!voiceId) {
        throw new Error("Inworld voiceId missing — set messages.tts.providers.inworld.voiceId");
      }
      const audioBuffer = await inworldTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        modelId,
        voiceId,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
