import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSecretInputString } from "openclaw/plugin-sdk/core";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";

function getRuntimeConfig(coreConfig: CoreConfig | null | undefined): OpenClawConfig | null {
  if (!coreConfig) {
    return null;
  }
  return coreConfig as OpenClawConfig;
}

function describeValue(value: SecretInput | undefined): string {
  if (typeof value === "string") {
    return "inline string";
  }
  if (value && typeof value === "object") {
    const ref = value as { source?: string; provider?: string; id?: string };
    return `SecretRef ${ref.source ?? "?"}:${ref.provider ?? "?"}:${ref.id ?? "?"}`;
  }
  return "missing value";
}

export async function resolveVoiceCallSecretInputString(params: {
  coreConfig: CoreConfig | null | undefined;
  value: SecretInput | undefined;
  envVar?: string;
  path: string;
}): Promise<string | undefined> {
  const runtimeConfig = getRuntimeConfig(params.coreConfig);
  if (!runtimeConfig) {
    const inline = normalizeSecretInputString(params.value);
    if (inline) {
      return inline;
    }
    if (hasConfiguredSecretInput(params.value)) {
      throw new Error(
        `${params.path}: ${describeValue(params.value)} requires runtime SecretRef resolution, but core config is unavailable`,
      );
    }
    if (!params.envVar) {
      return undefined;
    }
    return normalizeSecretInputString(process.env[params.envVar]);
  }

  const resolved = await resolveSecretInputString({
    config: runtimeConfig,
    value: params.value,
    env: process.env,
  });
  if (resolved) {
    return resolved;
  }
  if (!params.envVar) {
    return undefined;
  }
  return normalizeSecretInputString(process.env[params.envVar]);
}

export function hasVoiceCallSecretInput(params: {
  value: SecretInput | undefined;
  envVar?: string;
}): boolean {
  return (
    hasConfiguredSecretInput(params.value) ||
    (!!params.envVar && !!normalizeSecretInputString(process.env[params.envVar]))
  );
}

export async function resolveVoiceCallRuntimeSecrets(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
}): Promise<VoiceCallConfig> {
  const { config, coreConfig } = params;
  const resolved: VoiceCallConfig = {
    ...config,
    telnyx: config.telnyx ? { ...config.telnyx } : config.telnyx,
    twilio: config.twilio ? { ...config.twilio } : config.twilio,
    plivo: config.plivo ? { ...config.plivo } : config.plivo,
    tunnel: config.tunnel ? { ...config.tunnel } : config.tunnel,
    streaming: config.streaming ? { ...config.streaming } : config.streaming,
    tts: config.tts
      ? {
          ...config.tts,
          openai: config.tts.openai ? { ...config.tts.openai } : config.tts.openai,
          elevenlabs: config.tts.elevenlabs ? { ...config.tts.elevenlabs } : config.tts.elevenlabs,
        }
      : config.tts,
  };

  if (resolved.telnyx) {
    resolved.telnyx.apiKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.telnyx.apiKey,
      envVar: "TELNYX_API_KEY",
      path: "plugins.entries.voice-call.config.telnyx.apiKey",
    });
    resolved.telnyx.publicKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.telnyx.publicKey,
      envVar: "TELNYX_PUBLIC_KEY",
      path: "plugins.entries.voice-call.config.telnyx.publicKey",
    });
  }

  if (resolved.twilio) {
    resolved.twilio.authToken = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.twilio.authToken,
      envVar: "TWILIO_AUTH_TOKEN",
      path: "plugins.entries.voice-call.config.twilio.authToken",
    });
  }

  if (resolved.plivo) {
    resolved.plivo.authToken = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.plivo.authToken,
      envVar: "PLIVO_AUTH_TOKEN",
      path: "plugins.entries.voice-call.config.plivo.authToken",
    });
  }

  if (resolved.tunnel) {
    resolved.tunnel.ngrokAuthToken = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.tunnel.ngrokAuthToken,
      envVar: "NGROK_AUTHTOKEN",
      path: "plugins.entries.voice-call.config.tunnel.ngrokAuthToken",
    });
  }

  if (resolved.streaming) {
    resolved.streaming.openaiApiKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.streaming.openaiApiKey,
      envVar: "OPENAI_API_KEY",
      path: "plugins.entries.voice-call.config.streaming.openaiApiKey",
    });
    resolved.streaming.elevenlabsApiKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.streaming.elevenlabsApiKey,
      envVar: "ELEVENLABS_API_KEY",
      path: "plugins.entries.voice-call.config.streaming.elevenlabsApiKey",
    });
  }

  if (resolved.tts?.openai) {
    resolved.tts.openai.apiKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.tts.openai.apiKey,
      envVar: "OPENAI_API_KEY",
      path: "plugins.entries.voice-call.config.tts.openai.apiKey",
    });
  }

  if (resolved.tts?.elevenlabs) {
    resolved.tts.elevenlabs.apiKey = await resolveVoiceCallSecretInputString({
      coreConfig,
      value: resolved.tts.elevenlabs.apiKey,
      envVar: "ELEVENLABS_API_KEY",
      path: "plugins.entries.voice-call.config.tts.elevenlabs.apiKey",
    });
  }

  return resolved;
}

export function normalizeResolvedVoiceCallSecretString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  return normalizeResolvedSecretInputString({
    value: params.value,
    path: params.path,
  });
}
