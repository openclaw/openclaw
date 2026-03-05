import type { Readable } from "node:stream";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

export type TelephonyTtsRuntime = {
  textToSpeechTelephony: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    error?: string;
  }>;
  textToSpeechTelephonyStream?: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
  }) => Promise<{
    success: boolean;
    stream?: Readable;
    sampleRate?: number;
    provider?: string;
    error?: string;
    cleanup?: () => void;
  }>;
};

export type TelephonyTtsProvider = {
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
  synthesizeForTelephonyStream?: (text: string) => Promise<{
    stream: Readable;
    sampleRate: number;
    cleanup: () => void;
  }>;
};

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);

  const provider: TelephonyTtsProvider = {
    synthesizeForTelephony: async (text: string) => {
      const result = await runtime.textToSpeechTelephony({
        text,
        cfg: mergedConfig,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },
  };

  if (runtime.textToSpeechTelephonyStream) {
    const streamFn = runtime.textToSpeechTelephonyStream;
    provider.synthesizeForTelephonyStream = async (text: string) => {
      const result = await streamFn({
        text,
        cfg: mergedConfig,
      });

      if (!result.success || !result.stream || !result.sampleRate) {
        throw new Error(result.error ?? "TTS streaming failed");
      }

      return {
        stream: result.stream,
        sampleRate: result.sampleRate,
        cleanup: result.cleanup ?? (() => {}),
      };
    };
  }

  return provider;
}

function applyTtsOverride(coreConfig: CoreConfig, override?: VoiceCallTtsConfig): CoreConfig {
  if (!override) {
    return coreConfig;
  }

  const base = coreConfig.messages?.tts;
  const merged = mergeTtsConfig(base, override);
  if (!merged) {
    return coreConfig;
  }

  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged,
    },
  };
}

function mergeTtsConfig(
  base?: VoiceCallTtsConfig,
  override?: VoiceCallTtsConfig,
): VoiceCallTtsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!override) {
    return base;
  }
  if (!base) {
    return override;
  }
  return deepMerge(base, override);
}

function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const existing = (base as Record<string, unknown>)[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
