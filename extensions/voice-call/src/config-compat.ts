import type { VoiceCallConfig } from "./config.js";
import { VoiceCallConfigSchema } from "./config.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  if (typeof streaming?.openaiApiKey === "string") {
    legacyStreamingOpenAICompat.apiKey = streaming.openaiApiKey;
  }
  if (typeof streaming?.sttModel === "string") {
    legacyStreamingOpenAICompat.model = streaming.sttModel;
  }
  if (typeof streaming?.silenceDurationMs === "number") {
    legacyStreamingOpenAICompat.silenceDurationMs = streaming.silenceDurationMs;
  }
  if (typeof streaming?.vadThreshold === "number") {
    legacyStreamingOpenAICompat.vadThreshold = streaming.vadThreshold;
  }

  const normalizedStreaming = streaming
    ? {
        ...streaming,
        provider:
          typeof streaming.provider === "string"
            ? streaming.provider
            : typeof streaming.sttProvider === "string"
              ? streaming.sttProvider
              : undefined,
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
