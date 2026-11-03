import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import {
  buildElevenLabsSpeechRequestBody,
  DEFAULT_ELEVENLABS_MODEL_ID,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  ELEVENLABS_TTS_MODELS,
} from "openclaw/plugin-sdk/speech-provider";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { resolveClawRouterCapabilityHttpContext } from "./capability-offers.js";

const OUTPUT_FORMAT = "mp3_44100_128";
const VOICE_PATH = "/v1/text-to-speech/${voice_id}";

export function readElevenLabsSpeechConfig(raw: Record<string, unknown>) {
  const model = raw.model ?? raw.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const voice =
    raw.speakerVoice ??
    raw.speakerVoiceId ??
    raw.voice ??
    raw.voiceId ??
    DEFAULT_ELEVENLABS_VOICE_ID;
  if (typeof model !== "string" || !ELEVENLABS_TTS_MODELS.some((id) => id === model)) {
    throw new Error("ClawRouter ElevenLabs speech requires a qualified native model_id input");
  }
  if (typeof voice !== "string" || !/^[A-Za-z0-9]{10,40}$/u.test(voice)) {
    throw new Error(
      "ClawRouter ElevenLabs speech requires a 10-40 character alphanumeric voice ID",
    );
  }
  if (
    [raw.outputFormat, raw.responseFormat].some(
      (value) => value !== undefined && value !== OUTPUT_FORMAT,
    )
  ) {
    throw new Error("ClawRouter ElevenLabs speech requires mp3_44100_128 output");
  }
  if (
    [raw.instructions, raw.stream, raw.query, raw.body, raw.headers].some(
      (value) => value !== undefined,
    )
  ) {
    throw new Error(
      "ClawRouter ElevenLabs speech does not support raw request or streaming overrides",
    );
  }
  const settings = asOptionalRecord(raw.voiceSettings);
  if (
    (raw.voiceSettings !== undefined && !settings) ||
    (settings &&
      Object.keys(settings).some((key) => !Object.hasOwn(DEFAULT_ELEVENLABS_VOICE_SETTINGS, key)))
  ) {
    throw new Error("Invalid ClawRouter ElevenLabs voiceSettings");
  }
  const inputSettings = {
    ...DEFAULT_ELEVENLABS_VOICE_SETTINGS,
    ...settings,
    ...(raw.speed !== undefined ? { speed: raw.speed } : {}),
  };
  const readSetting = (key: "stability" | "similarityBoost" | "style" | "speed") => {
    const value = inputSettings[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < (key === "speed" ? 0.5 : 0) ||
      value > (key === "speed" ? 2 : 1)
    ) {
      throw new Error("Invalid ClawRouter ElevenLabs voice setting: " + key);
    }
    return value;
  };
  if (typeof inputSettings.useSpeakerBoost !== "boolean") {
    throw new Error("Invalid ClawRouter ElevenLabs useSpeakerBoost");
  }
  const voiceSettings = {
    stability: readSetting("stability"),
    similarityBoost: readSetting("similarityBoost"),
    style: readSetting("style"),
    useSpeakerBoost: inputSettings.useSpeakerBoost,
    speed: readSetting("speed"),
  };
  const { seed, applyTextNormalization, languageCode, latencyTier } = raw;
  if (
    seed !== undefined &&
    (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
  ) {
    throw new Error("Invalid ClawRouter ElevenLabs seed");
  }
  if (
    applyTextNormalization !== undefined &&
    applyTextNormalization !== "auto" &&
    applyTextNormalization !== "on" &&
    applyTextNormalization !== "off"
  ) {
    throw new Error("Invalid ClawRouter ElevenLabs applyTextNormalization");
  }
  if (
    languageCode !== undefined &&
    (typeof languageCode !== "string" || !/^[a-z]{2}$/u.test(languageCode))
  ) {
    throw new Error("Invalid ClawRouter ElevenLabs languageCode");
  }
  if (
    latencyTier !== undefined &&
    (typeof latencyTier !== "number" ||
      !Number.isInteger(latencyTier) ||
      latencyTier < 0 ||
      latencyTier > 4 ||
      model === "eleven_v3")
  ) {
    throw new Error("Invalid or unsupported ClawRouter ElevenLabs latencyTier");
  }
  return {
    model,
    voice,
    responseFormat: OUTPUT_FORMAT,
    voiceSettings,
    seed,
    applyTextNormalization,
    languageCode,
    latencyTier,
  };
}

export async function synthesizeElevenLabsSpeech(params: {
  request: SpeechSynthesisRequest;
  resolveContext: () => Promise<ReturnType<typeof resolveClawRouterCapabilityHttpContext>>;
  fetchWithSsrFGuard: PluginCapabilityCatalogContext["fetchWithSsrFGuard"];
  remaining: () => number;
}) {
  const { request: req, remaining } = params;
  const overrides = req.providerOverrides ?? {};
  const config = readElevenLabsSpeechConfig({
    ...req.providerConfig,
    ...overrides,
    model:
      overrides.model ??
      overrides.modelId ??
      req.providerConfig.model ??
      req.providerConfig.modelId,
    voice:
      overrides.voice ??
      overrides.voiceId ??
      req.providerConfig.voice ??
      req.providerConfig.voiceId,
  });
  if (req.target === "voice-note" || req.target === "telephony") {
    throw new Error("ClawRouter ElevenLabs voice-note and telephony output are not qualified");
  }
  if (
    !req.text.trim() ||
    req.text.length > 20000 ||
    Array.from(req.text).length > 10000 ||
    /[\ud800-\udfff]/u.test(req.text)
  ) {
    throw new Error("ClawRouter ElevenLabs speech requires 1-10000 valid Unicode characters");
  }
  const http = await params.resolveContext();
  // Only the proxy bearer credential authorizes this route, including catalog discovery.
  http.headers.delete("xi-api-key");
  http.headers.delete("x-api-key");
  const { fetchClawRouterCapabilityOffers } = await import("./capability-offers.js");
  const offers = await fetchClawRouterCapabilityOffers({
    context: http,
    timeoutMs: remaining,
    requireFreshProxyCatalog: true,
    nativePathParams: { voice_id: config.voice },
  });
  const offer = offers.find(
    (candidate) =>
      candidate.providerId === "elevenlabs" &&
      candidate.endpoint === "speech" &&
      candidate.path === VOICE_PATH &&
      candidate.model === undefined &&
      candidate.methods.includes("POST") &&
      candidate.requestFormat === "elevenlabs.speech" &&
      candidate.responseFormat === "audio.binary" &&
      (candidate.routeKind === "native" || candidate.routeKind === "manifest"),
  );
  if (!offer) throw new Error("ClawRouter ElevenLabs speech has no eligible supported offer");
  const body = buildElevenLabsSpeechRequestBody({
    text: req.text,
    modelId: config.model,
    voiceSettings: config.voiceSettings,
    seed: config.seed,
    applyTextNormalization: config.applyTextNormalization,
    languageCode: config.languageCode,
  });
  const query: Record<string, string> = { output_format: OUTPUT_FORMAT };
  if (config.latencyTier !== undefined)
    query.optimize_streaming_latency = String(config.latencyTier);
  const url = new URL(offer.url);
  if (offer.routeKind === "native") url.search = new URLSearchParams(query).toString();
  const headers = new Headers(http.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "audio/mpeg");
  const { mergeSsrFPolicies } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const { response, release } = await params.fetchWithSsrFGuard({
    url: url.toString(),
    maxRedirects: 0,
    timeoutMs: remaining(),
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(
        offer.routeKind === "manifest"
          ? { body, pathParams: { voice_id: config.voice }, query }
          : body,
      ),
    },
    policy: mergeSsrFPolicies(
      http.ssrfPolicy,
      http.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
    ),
    dispatcherPolicy: http.dispatcherPolicy,
    auditContext: "clawrouter.elevenlabs.speech",
  });
  try {
    await assertOkOrThrowProviderError(response, "ClawRouter speech error", {
      requestHeaders: headers,
    });
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.has("content-range") ||
      (encoding !== undefined && encoding !== "identity") ||
      response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
    ) {
      throw new Error("ClawRouter ElevenLabs speech requires complete audio/mpeg output");
    }
    const audioBuffer = await readProviderBinaryResponse(
      response,
      "ClawRouter speech error",
      "audio",
      {
        maxBytes: Math.min(16 * 1024 * 1024, resolveGeneratedMediaMaxBytes(req.cfg, "audio")),
        timeoutMs: remaining,
        onOverflow: () => new Error("ClawRouter speech audio response exceeds configured limit"),
      },
    );
    return {
      audioBuffer,
      outputFormat: OUTPUT_FORMAT,
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  } finally {
    void response.body?.cancel().catch(() => undefined);
    await release();
  }
}
