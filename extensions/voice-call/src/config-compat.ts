import type { VoiceCallConfig } from "./config.js";
import { VoiceCallConfigSchema } from "./config.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" ? value : undefined;
}

function mergeProviderConfig(
  providersValue: unknown,
  providerId: string,
  compatValues: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(compatValues).length === 0) {
    return asObject(providersValue);
  }

  const providers = asObject(providersValue) ?? {};
  const existing = asObject(providers[providerId]) ?? {};
  return {
    ...providers,
    [providerId]: {
      ...existing,
      ...compatValues,
    },
  };
}

export function normalizeVoiceCallLegacyConfigInput(value: unknown): Record<string, unknown> {
  const raw = asObject(value) ?? {};
  const twilio = asObject(raw.twilio);
  const streaming = asObject(raw.streaming);

  const legacyStreamingOpenAICompat: Record<string, unknown> = {};
  const streamingOpenAIApiKey = getString(streaming, "openaiApiKey");
  if (streamingOpenAIApiKey) {
    legacyStreamingOpenAICompat.apiKey = streamingOpenAIApiKey;
  }
  const streamingSttModel = getString(streaming, "sttModel");
  if (streamingSttModel) {
    legacyStreamingOpenAICompat.model = streamingSttModel;
  }
  const streamingSilenceDurationMs = getNumber(streaming, "silenceDurationMs");
  if (streamingSilenceDurationMs !== undefined) {
    legacyStreamingOpenAICompat.silenceDurationMs = streamingSilenceDurationMs;
  }
  const streamingVadThreshold = getNumber(streaming, "vadThreshold");
  if (streamingVadThreshold !== undefined) {
    legacyStreamingOpenAICompat.vadThreshold = streamingVadThreshold;
  }
  const streamingProvider = getString(streaming, "provider");
  const legacyStreamingProvider = getString(streaming, "sttProvider");

  const normalizedStreaming: Record<string, unknown> | undefined = streaming
    ? {
        ...streaming,
        provider: streamingProvider ?? legacyStreamingProvider,
        providers: mergeProviderConfig(streaming.providers, "openai", legacyStreamingOpenAICompat),
      }
    : undefined;

  if (normalizedStreaming) {
    delete normalizedStreaming.sttProvider;
    delete normalizedStreaming.openaiApiKey;
    delete normalizedStreaming.sttModel;
    delete normalizedStreaming.silenceDurationMs;
    delete normalizedStreaming.vadThreshold;
  }

  const normalizedTwilio = twilio
    ? {
        ...twilio,
      }
    : undefined;
  if (normalizedTwilio) {
    delete normalizedTwilio.from;
  }

  return {
    ...raw,
    provider: raw.provider === "log" ? "mock" : raw.provider,
    fromNumber: raw.fromNumber ?? (typeof twilio?.from === "string" ? twilio.from : undefined),
    twilio: normalizedTwilio,
    streaming: normalizedStreaming,
  };
}

export function parseVoiceCallPluginConfig(value: unknown): VoiceCallConfig {
  return VoiceCallConfigSchema.parse(normalizeVoiceCallLegacyConfigInput(value));
}
