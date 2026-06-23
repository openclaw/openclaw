// Elevenlabs plugin module implements tts behavior.
import {
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
  readProviderBinaryResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isValidElevenLabsVoiceId, normalizeElevenLabsBaseUrl } from "./shared.js";

function assertElevenLabsVoiceSettings(settings: {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  speed: number;
}) {
  requireInRange(settings.stability, 0, 1, "stability");
  requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
  requireInRange(settings.style, 0, 1, "style");
  requireInRange(settings.speed, 0.5, 2, "speed");
}

function resolveElevenLabsAcceptHeader(outputFormat: string): string | undefined {
  const normalized = outputFormat.trim().toLowerCase();
  if (!normalized || normalized.startsWith("mp3_")) {
    return "audio/mpeg";
  }
  return undefined;
}

function normalizeElevenLabsLatencyTier(latencyTier: number | undefined): number | undefined {
  if (latencyTier === undefined || !Number.isFinite(latencyTier)) {
    return undefined;
  }
  if (!Number.isSafeInteger(latencyTier)) {
    throw new Error("latencyTier must be an integer");
  }
  requireInRange(latencyTier, 0, 4, "latencyTier");
  return latencyTier;
}

type ElevenLabsTtsRequestParams = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  latencyTier?: number;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
    speed: number;
  };
  timeoutMs: number;
};

type ElevenLabsTtsRequestVariant = "tts" | "stream" | "with-timestamps";

const ELEVENLABS_TTS_VARIANT_PATH_SUFFIX: Record<ElevenLabsTtsRequestVariant, string> = {
  tts: "",
  stream: "/stream",
  "with-timestamps": "/with-timestamps",
};

function prepareElevenLabsTtsRequest(
  params: ElevenLabsTtsRequestParams & { variant: ElevenLabsTtsRequestVariant },
): {
  url: URL;
  normalizedBaseUrl: string;
  acceptHeader?: string;
  body: string;
} {
  const {
    text,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    latencyTier,
    voiceSettings,
  } = params;
  if (!isValidElevenLabsVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);
  const normalizedBaseUrl = normalizeElevenLabsBaseUrl(baseUrl);
  const normalizedLatencyTier = normalizeElevenLabsLatencyTier(latencyTier);
  const url = new URL(
    `${normalizedBaseUrl}/v1/text-to-speech/${voiceId}${ELEVENLABS_TTS_VARIANT_PATH_SUFFIX[params.variant]}`,
  );
  if (outputFormat) {
    url.searchParams.set("output_format", outputFormat);
  }
  const supportsStreamingLatency = modelId.trim().toLowerCase() !== "eleven_v3";
  if (normalizedLatencyTier !== undefined && supportsStreamingLatency) {
    url.searchParams.set("optimize_streaming_latency", normalizedLatencyTier.toString());
  }
  // The with-timestamps endpoint responds with JSON (base64 audio + character alignment),
  // not raw audio bytes.
  const acceptHeader =
    params.variant === "with-timestamps"
      ? "application/json"
      : resolveElevenLabsAcceptHeader(outputFormat);
  return {
    url,
    normalizedBaseUrl,
    acceptHeader,
    body: JSON.stringify({
      text,
      model_id: modelId,
      seed: normalizedSeed,
      apply_text_normalization: normalizedNormalization,
      language_code: normalizedLanguage,
      voice_settings: {
        stability: voiceSettings.stability,
        similarity_boost: voiceSettings.similarityBoost,
        style: voiceSettings.style,
        use_speaker_boost: voiceSettings.useSpeakerBoost,
        speed: voiceSettings.speed,
      },
    }),
  };
}

export async function elevenLabsTTS(params: ElevenLabsTtsRequestParams): Promise<Buffer> {
  const { apiKey, timeoutMs } = params;
  const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
    ...params,
    variant: "tts",
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");

    return Buffer.from(await readProviderBinaryResponse(response, "ElevenLabs API error", "audio"));
  } finally {
    await release();
  }
}

/** Per-character speech timing parsed from a `/with-timestamps` response alignment block. */
export type ElevenLabsTtsAlignment = {
  characters: string[];
  startTimesSeconds: number[];
};

function parseElevenLabsAlignment(raw: unknown): ElevenLabsTtsAlignment | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const { characters, character_start_times_seconds: starts } = raw as {
    characters?: unknown;
    character_start_times_seconds?: unknown;
  };
  if (!Array.isArray(characters) || !Array.isArray(starts)) {
    return undefined;
  }
  const n = Math.min(characters.length, starts.length);
  const outChars: string[] = [];
  const outTimes: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = characters[i];
    const t = starts[i];
    if (typeof c !== "string" || typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      return undefined;
    }
    outChars.push(c);
    outTimes.push(t);
  }
  return outChars.length > 0 ? { characters: outChars, startTimesSeconds: outTimes } : undefined;
}

/**
 * Synthesize via `/v1/text-to-speech/{voiceId}/with-timestamps`: same request shape as
 * {@link elevenLabsTTS} but the response is JSON carrying base64 audio plus per-character
 * alignment. `normalized_alignment` (timing for the text as actually spoken, after number and
 * abbreviation expansion) is preferred over `alignment`; a malformed or absent alignment block
 * degrades to audio-only rather than failing the synthesis.
 */
export async function elevenLabsTTSWithTimestamps(params: ElevenLabsTtsRequestParams): Promise<{
  audioBuffer: Buffer;
  alignment?: ElevenLabsTtsAlignment;
}> {
  const { apiKey, timeoutMs } = params;
  const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
    ...params,
    variant: "with-timestamps",
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.tts.with-timestamps",
  });
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");
    const payload = (await response.json()) as {
      audio_base64?: unknown;
      alignment?: unknown;
      normalized_alignment?: unknown;
    };
    if (typeof payload.audio_base64 !== "string" || payload.audio_base64.length === 0) {
      throw new Error("ElevenLabs API response missing audio (with-timestamps)");
    }
    const audioBuffer = Buffer.from(payload.audio_base64, "base64");
    if (audioBuffer.length === 0) {
      throw new Error("ElevenLabs API response audio decoded empty (with-timestamps)");
    }
    return {
      audioBuffer,
      alignment:
        parseElevenLabsAlignment(payload.normalized_alignment) ??
        parseElevenLabsAlignment(payload.alignment),
    };
  } finally {
    await release();
  }
}

export async function elevenLabsTTSStream(params: ElevenLabsTtsRequestParams): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { apiKey, timeoutMs } = params;
  const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
    ...params,
    variant: "stream",
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.tts.stream",
  });
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");
    assertProviderBinaryResponseContent(response, "ElevenLabs API error", "audio");
    if (!response.body) {
      throw new Error("ElevenLabs API response missing audio stream");
    }
    handedOff = true;
    return {
      audioStream: response.body,
      release,
    };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}
