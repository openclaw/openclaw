import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import {
  buildOpenAiSpeechRequestBody,
  recordModelFallbackStop,
} from "openclaw/plugin-sdk/speech-provider";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { resolveClawRouterCapabilityHttpContext } from "./capability-offers.js";

export const OPENROUTER_SPEECH_MODELS = [
  "hexgrad/kokoro-82m",
  "elevenlabs/eleven-turbo-v2",
  "mistralai/voxtral-mini-tts-2603",
];
const PATH = "/v1/audio/speech";

export function readOpenRouterSpeechConfig(raw: Record<string, unknown>) {
  const model = raw.model ?? raw.modelId ?? "openrouter/hexgrad/kokoro-82m";
  const voice = raw.speakerVoice ?? raw.speakerVoiceId ?? raw.voice ?? raw.voiceId ?? "af_alloy";
  if (
    typeof model !== "string" ||
    !OPENROUTER_SPEECH_MODELS.some((id) => model === "openrouter/" + id)
  ) {
    throw new Error("ClawRouter OpenRouter speech requires a qualified catalog model ID");
  }
  if (typeof voice !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(voice)) {
    throw new Error("Invalid ClawRouter OpenRouter speech voice");
  }
  if (
    [raw.outputFormat, raw.responseFormat].some(
      (value) => value !== undefined && value !== "mp3",
    ) ||
    [raw.instructions, raw.stream, raw.query, raw.body, raw.headers].some(
      (value) => value !== undefined,
    )
  ) {
    throw new Error("ClawRouter OpenRouter speech requires MP3 without raw request overrides");
  }
  const speed = raw.speed;
  if (
    speed !== undefined &&
    (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.25 || speed > 4)
  ) {
    throw new Error("ClawRouter OpenRouter speech speed must be between 0.25 and 4");
  }
  const provider = asOptionalRecord(raw.provider);
  if (
    (raw.provider !== undefined && !provider) ||
    (provider &&
      (Object.keys(provider).some((key) => key !== "zdr" && key !== "data_collection") ||
        (provider.zdr !== undefined && typeof provider.zdr !== "boolean") ||
        (provider.data_collection !== undefined &&
          provider.data_collection !== "allow" &&
          provider.data_collection !== "deny")))
  ) {
    throw new Error("ClawRouter OpenRouter speech only accepts qualified data policy flags");
  }
  return { model, voice, speed, provider, responseFormat: "mp3" };
}

export async function synthesizeOpenRouterSpeech(params: {
  request: SpeechSynthesisRequest;
  resolveContext: () => Promise<ReturnType<typeof resolveClawRouterCapabilityHttpContext>>;
  fetchWithSsrFGuard: PluginCapabilityCatalogContext["fetchWithSsrFGuard"];
  remaining: () => number;
}) {
  const { request: req, remaining } = params;
  req.signal?.throwIfAborted();
  if (req.target === "telephony") {
    throw new Error("ClawRouter OpenRouter MP3 speech is not a telephony PCM source");
  }
  const base = readOpenRouterSpeechConfig(req.providerConfig);
  const overrides = req.providerOverrides ?? {};
  const config = readOpenRouterSpeechConfig({
    ...base,
    ...overrides,
    model: overrides.model ?? overrides.modelId ?? base.model,
    voice: overrides.voice ?? overrides.voiceId ?? base.voice,
  });
  if (!req.text.trim() || req.text.length > 32768 || /[\ud800-\udfff]/u.test(req.text)) {
    throw new Error("ClawRouter OpenRouter speech requires 1-32768 valid UTF-16 text units");
  }
  const http = await params.resolveContext();
  req.signal?.throwIfAborted();
  http.headers.delete("x-api-key");
  http.headers.delete("xi-api-key");
  const { fetchClawRouterCapabilityOffers } = await import("./capability-offers.js");
  const offers = await fetchClawRouterCapabilityOffers({
    context: http,
    timeoutMs: remaining,
    signal: req.signal,
    requireFreshProxyCatalog: true,
  });
  const offer = offers.find(
    (candidate) =>
      candidate.providerId === "openrouter" &&
      candidate.path === PATH &&
      candidate.methods.includes("POST") &&
      candidate.requestFormat === "openai.audio_speech" &&
      candidate.responseFormat === "audio.binary" &&
      (candidate.routeKind === "native" || candidate.routeKind === "manifest") &&
      candidate.model !== undefined &&
      candidate.model.id === config.model &&
      OPENROUTER_SPEECH_MODELS.some(
        (id) => candidate.model?.upstream === id && config.model === "openrouter/" + id,
      ) &&
      Array.isArray(candidate.model.capabilities) &&
      candidate.model.capabilities.includes("audio.speech"),
  );
  if (!offer) {
    throw new Error("ClawRouter OpenRouter speech has no eligible supported offer");
  }
  const upstream = offer.model?.upstream;
  if (typeof upstream !== "string") {
    throw new Error("ClawRouter OpenRouter speech offer has no bound model");
  }
  const body = buildOpenAiSpeechRequestBody({
    model: upstream,
    text: req.text,
    voice: config.voice,
    responseFormat: "mp3",
    speed: config.speed,
    extraBody: config.provider ? { provider: config.provider } : undefined,
  });
  const serialized = JSON.stringify(offer.routeKind === "manifest" ? { body } : body);
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error("ClawRouter OpenRouter speech request exceeds 256 KiB");
  }
  const headers = new Headers(http.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "audio/mpeg");
  const { mergeSsrFPolicies } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  let attempted = false;
  try {
    const { response, release } = await params.fetchWithSsrFGuard({
      url: offer.url,
      maxRedirects: 0,
      timeoutMs: remaining(),
      init: { method: "POST", headers, body: serialized, signal: req.signal },
      beforeRequest: () => {
        req.signal?.throwIfAborted();
        remaining();
        attempted = true;
      },
      policy: mergeSsrFPolicies(
        http.ssrfPolicy,
        http.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: http.dispatcherPolicy,
      auditContext: "clawrouter.openrouter.speech",
    });
    try {
      await assertOkOrThrowProviderError(response, "ClawRouter speech error", {
        requestHeaders: headers,
        signal: req.signal,
        bodyTimeoutMs: remaining,
      });
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.has("content-range") ||
        (encoding !== undefined && encoding !== "identity") ||
        response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
      ) {
        throw new Error("ClawRouter OpenRouter speech requires complete audio/mpeg output");
      }
      const audioBuffer = await readProviderBinaryResponse(
        response,
        "ClawRouter speech error",
        "audio",
        {
          maxBytes: Math.min(16 * 1024 * 1024, resolveGeneratedMediaMaxBytes(req.cfg, "audio")),
          timeoutMs: remaining,
          signal: req.signal,
        },
      );
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/u.test(length) || Number(length) !== audioBuffer.byteLength)
      ) {
        throw new Error(
          "ClawRouter OpenRouter speech response length does not match complete output",
        );
      }
      remaining();
      req.signal?.throwIfAborted();
      return { audioBuffer, outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: true };
    } finally {
      void response.body?.cancel().catch(() => undefined);
      await release();
    }
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error("ClawRouter speech failed", { cause: error });
    if (attempted) {
      // Replay policy only: completed or uncertain delivery does not imply a refund.
      recordModelFallbackStop(failure);
    }
    throw failure;
  }
}
