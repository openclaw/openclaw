import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";
import { parseSpeechDirectiveNumberOverride } from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Runtime SDK modules (HTTP, SSRF, media) load via `await import()` on purpose: index.ts and
// capability-catalog.ts import this file for registration metadata, which must stay cheap.
const PROVIDER_ID = "kokoro-cpp";
const DEFAULT_BASE_URL = "http://127.0.0.1:8880/v1";
const DEFAULT_VOICE = "af_maple";
// kokoro-server ignores the model; OpenAI-compatible servers such as Kokoro-FastAPI expect one.
const REQUEST_MODEL = "kokoro";
const SPEED_RANGE = { min: 0.25, max: 4 };
const TELEPHONY_SAMPLE_RATE = 24_000;
const VOICES_MAX_BYTES = 256 * 1024;
const DEFAULT_VOICES_TIMEOUT_MS = 10_000;

const VOICE_LOCALES: Record<string, string> = {
  a: "en-US",
  b: "en-GB",
  d: "de-DE",
  e: "es-ES",
  z: "zh-CN",
};
const VOICE_GENDERS: Record<string, string> = { f: "female", m: "male" };

type KokoroCppConfig = {
  baseUrl: string;
  voice: string;
  speed?: number;
};

type SpeechFormat = "wav" | "pcm";

function readSpeed(value: unknown): number | undefined {
  const speed = asFiniteNumber(value);
  if (speed !== undefined && (speed < SPEED_RANGE.min || speed > SPEED_RANGE.max)) {
    throw new Error(`Invalid kokoro.cpp speed: ${speed} (0.25-4)`);
  }
  return speed;
}

function readKokoroCppConfig(raw: Record<string, unknown>): KokoroCppConfig {
  const speed = readSpeed(raw.speed);
  return {
    baseUrl: (normalizeOptionalString(raw.baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/u, ""),
    voice: normalizeOptionalString(raw.voice ?? raw.voiceId ?? raw.speakerVoice) ?? DEFAULT_VOICE,
    ...(speed === undefined ? {} : { speed }),
  };
}

function resolveKokoroCppConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const entry = asOptionalRecord(asOptionalRecord(rawConfig.providers)?.[PROVIDER_ID]);
  return entry ? readKokoroCppConfig(entry) : {};
}

async function requestSpeech(params: {
  config: KokoroCppConfig;
  text: string;
  voice: string;
  speed?: number;
  format: SpeechFormat;
  timeoutMs: number;
  maxBytes: number;
}): Promise<Buffer> {
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { baseUrl } = params.config;
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/audio/speech`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: REQUEST_MODEL,
        input: params.text,
        voice: params.voice,
        response_format: params.format,
        ...(params.speed == null ? {} : { speed: params.speed }),
      }),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "kokoro-cpp.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "kokoro.cpp TTS API error");
    return await readProviderBinaryResponse(response, "kokoro.cpp TTS API error", "audio", {
      maxBytes: params.maxBytes,
    });
  } finally {
    await release();
  }
}

async function synthesizeFormat(
  req: Omit<SpeechSynthesisRequest, "target">,
  format: SpeechFormat,
): Promise<Buffer> {
  const config = readKokoroCppConfig(req.providerConfig);
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  return await requestSpeech({
    config,
    text: req.text,
    voice: normalizeOptionalString(req.providerOverrides?.voice) ?? config.voice,
    speed: asFiniteNumber(req.providerOverrides?.speed) ?? config.speed,
    format,
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
  });
}

function toVoiceOption(id: string): SpeechVoiceOption {
  const match = /^([abdez])([fm])_/u.exec(id);
  if (!match) {
    return { id, name: id };
  }
  return {
    id,
    name: id,
    locale: VOICE_LOCALES[match[1] ?? ""],
    gender: VOICE_GENDERS[match[2] ?? ""],
  };
}

async function listKokoroCppVoices(req: SpeechListVoicesRequest): Promise<SpeechVoiceOption[]> {
  const config = readKokoroCppConfig(req.providerConfig ?? {});
  const baseUrl = normalizeOptionalString(req.baseUrl)?.replace(/\/+$/u, "") ?? config.baseUrl;
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/audio/voices`,
    timeoutMs: req.timeoutMs ?? DEFAULT_VOICES_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "kokoro-cpp.voices",
  });
  let payload: unknown;
  try {
    await assertOkOrThrowProviderError(response, "kokoro.cpp voices API error");
    payload = await readProviderJsonResponse<unknown>(response, "kokoro.cpp voices", {
      maxBytes: VOICES_MAX_BYTES,
    });
  } finally {
    await release();
  }
  const voices = asOptionalRecord(payload)?.voices;
  if (!Array.isArray(voices)) {
    throw new Error("kokoro.cpp voices API returned no voices list");
  }
  return voices.flatMap((voice) => (typeof voice === "string" ? [toVoiceOption(voice)] : []));
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
): SpeechDirectiveTokenParseResult {
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case "kokoro_voice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "speed":
    case "kokoro_speed":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "speed",
        range: SPEED_RANGE,
        warning: (value) => `invalid kokoro.cpp speed "${value}" (0.25-4.0)`,
      });
    default:
      return { handled: false };
  }
}

export function buildKokoroCppSpeechProvider(): SpeechProviderPlugin {
  // Keyless local provider: opt in only through an explicit tts.providers["kokoro-cpp"] entry.
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    typeof providerConfig.baseUrl === "string";
  return {
    id: PROVIDER_ID,
    label: "kokoro.cpp",
    autoSelectOrder: 900,
    resolveConfig: ({ rawConfig }) => resolveKokoroCppConfig(rawConfig),
    parseDirectiveToken,
    listVoices: listKokoroCppVoices,
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const audioBuffer = await synthesizeFormat(req, "wav");
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer,
            inputExtension: "wav",
            tempPrefix: "tts-kokoro-cpp-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return { audioBuffer, outputFormat: "wav", fileExtension: ".wav", voiceCompatible: false };
    },
    synthesizeTelephony: async (req) => ({
      audioBuffer: await synthesizeFormat(req, "pcm"),
      outputFormat: "pcm",
      sampleRate: TELEPHONY_SAMPLE_RATE,
    }),
  };
}
