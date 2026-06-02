import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  parseTtsDirectives,
  type SpeechModelOverridePolicy,
  type SpeechProviderConfig,
  type TtsDirectiveOverrides,
} from "openclaw/plugin-sdk/speech";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { deepMergeDefined } from "./deep-merge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

export type TelephonyTtsRuntime = {
  /**
   * Synthesize PCM audio through the core TTS runtime before telephony conversion.
   * Voice-call passes merged global/route config and any allowed directive overrides.
   */
  textToSpeechTelephony: (params: {
    /** Caller-facing speech text after voice-call strips directive control markup. */
    text: string;
    /** Core config after route-specific voice-call TTS overrides are merged in. */
    cfg: CoreConfig;
    /** Optional preference store path forwarded to core TTS runtimes that support it. */
    prefsPath?: string;
    /** Directive-controlled provider/model/voice overrides accepted by policy. */
    overrides?: TtsDirectiveOverrides;
  }) => Promise<{
    success: boolean;
    /** PCM audio returned by the selected TTS provider before 8 kHz mu-law conversion. */
    audioBuffer?: Buffer;
    /** Sample rate for the returned PCM buffer. Required on success. */
    sampleRate?: number;
    /** Provider that produced audio, used for fallback diagnostics. */
    provider?: string;
    /** Original provider when the TTS runtime failed over to another provider. */
    fallbackFrom?: string;
    /** Ordered provider attempts, when the runtime exposes a fallback chain. */
    attemptedProviders?: string[];
    /** Human-readable failure reason when synthesis did not produce audio. */
    error?: string;
  }>;
};

export type TelephonyTtsProvider = {
  /** Maximum time the call flow should wait for speech synthesis before falling back. */
  synthesisTimeoutMs: number;
  /**
   * Convert response text into 8 kHz mu-law audio that telephony providers can stream.
   * Throws when core TTS fails or omits the PCM buffer/sample rate required for conversion.
   */
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
};

/** Default wait budget for per-call telephony TTS synthesis before text fallback. */
export const TELEPHONY_DEFAULT_TTS_TIMEOUT_MS = 8000;

type TelephonyModelOverrideConfig = {
  enabled?: boolean;
  allowText?: boolean;
  allowProvider?: boolean;
  allowVoice?: boolean;
  allowModelId?: boolean;
  allowVoiceSettings?: boolean;
  allowNormalization?: boolean;
  allowSeed?: boolean;
};

/**
 * Builds the telephony TTS adapter that applies global/route voice-call overrides,
 * directive policy, fallback logging, and final PCM-to-mu-law conversion.
 */
export function createTelephonyTtsProvider(params: {
  /** Base core config supplied by the plugin host. */
  coreConfig: CoreConfig;
  /** Route-specific TTS config layered over `coreConfig.messages.tts`. */
  ttsOverride?: VoiceCallTtsConfig;
  /** Core TTS runtime bridge used before telephony audio conversion. */
  runtime: TelephonyTtsRuntime;
  /** Optional warning sink for ignored directives and provider fallbacks. */
  logger?: {
    warn?: (message: string) => void;
  };
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime, logger } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);
  const ttsConfig = mergedConfig.messages?.tts;
  const modelOverrides = resolveTelephonyModelOverridePolicy(
    readTelephonyModelOverrides(ttsConfig),
  );
  const providerConfigs = collectTelephonyProviderConfigs(ttsConfig);
  const activeProvider = normalizeProviderId(ttsConfig?.provider);
  const synthesisTimeoutMs = resolveTimerTimeoutMs(
    mergedConfig.messages?.tts?.timeoutMs,
    TELEPHONY_DEFAULT_TTS_TIMEOUT_MS,
  );

  return {
    synthesisTimeoutMs,
    synthesizeForTelephony: async (text: string) => {
      // Directive tags can hide caller-facing text or override speaker/model settings.
      // Parse them before sending text to TTS so callers never hear control syntax.
      const directives = parseTtsDirectives(text, modelOverrides, {
        cfg: mergedConfig,
        providerConfigs,
        preferredProviderId: activeProvider,
      });
      if (directives.warnings.length > 0) {
        logger?.warn?.(
          `[voice-call] Ignored telephony TTS directive overrides (${directives.warnings.join("; ")})`,
        );
      }
      const cleanText = directives.hasDirective
        ? directives.ttsText?.trim() || directives.cleanedText.trim()
        : text;
      const result = await runtime.textToSpeechTelephony({
        text: cleanText,
        cfg: mergedConfig,
        overrides: directives.overrides,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      if (result.fallbackFrom && result.provider && result.fallbackFrom !== result.provider) {
        const attemptedChain =
          result.attemptedProviders && result.attemptedProviders.length > 0
            ? result.attemptedProviders.join(" -> ")
            : `${result.fallbackFrom} -> ${result.provider}`;
        logger?.warn?.(
          `[voice-call] Telephony TTS fallback used from=${result.fallbackFrom} to=${result.provider} attempts=${attemptedChain}`,
        );
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },
  };
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
  // Number routes layer TTS settings over global voice-call TTS; deepMergeDefined
  // preserves existing nested provider fields while blocking prototype pollution.
  return deepMergeDefined(base, override) as VoiceCallTtsConfig;
}

function resolveTelephonyModelOverridePolicy(
  overrides: TelephonyModelOverrideConfig | undefined,
): SpeechModelOverridePolicy {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    // Disabled means no directive-controlled TTS surface at all, not just
    // falling back to per-field defaults.
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    // Provider swaps can cross billing/latency/security boundaries, so they
    // remain opt-in even when other directive overrides are enabled by default.
    allowProvider: allow(overrides?.allowProvider, false),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
  };
}

function readTelephonyModelOverrides(
  ttsConfig: VoiceCallTtsConfig | undefined,
): TelephonyModelOverrideConfig | undefined {
  const value = (ttsConfig as Record<string, unknown> | undefined)?.modelOverrides;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TelephonyModelOverrideConfig)
    : undefined;
}

function normalizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
}

function asProviderConfig(value: unknown): SpeechProviderConfig {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SpeechProviderConfig)
    : {};
}

function collectTelephonyProviderConfigs(
  ttsConfig: VoiceCallTtsConfig | undefined,
): Record<string, SpeechProviderConfig> {
  if (!ttsConfig) {
    return {};
  }
  const entries: Record<string, SpeechProviderConfig> = {};
  const rawProviders =
    ttsConfig.providers &&
    typeof ttsConfig.providers === "object" &&
    !Array.isArray(ttsConfig.providers)
      ? (ttsConfig.providers as Record<string, unknown>)
      : {};
  for (const [providerId, value] of Object.entries(rawProviders)) {
    const normalized = normalizeProviderId(providerId) ?? providerId;
    entries[normalized] = asProviderConfig(value);
  }
  // Older configs also allow provider blocks directly under messages.tts; keep those
  // readable for directive overrides without treating scalar TTS settings as providers.
  const reservedKeys = new Set([
    "auto",
    "enabled",
    "maxTextLength",
    "mode",
    "modelOverrides",
    "persona",
    "personas",
    "prefsPath",
    "provider",
    "providers",
    "summaryModel",
    "timeoutMs",
  ]);
  for (const [key, value] of Object.entries(ttsConfig as Record<string, unknown>)) {
    if (
      reservedKeys.has(key) ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      continue;
    }
    // Keep legacy direct provider blocks available to directive parsing, but do
    // not let scalar global TTS fields masquerade as provider configs.
    const normalized = normalizeProviderId(key) ?? key;
    entries[normalized] ??= asProviderConfig(value);
  }
  return entries;
}
