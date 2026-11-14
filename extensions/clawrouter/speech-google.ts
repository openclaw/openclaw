import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { recordModelFallbackStop } from "openclaw/plugin-sdk/speech-provider";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { resolveClawRouterCapabilityHttpContext } from "./capability-offers.js";

export const GOOGLE_SPEECH_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
] as const;
const PREVIEW_CUTOFF = Date.parse("2026-11-17T00:00:00Z");
const AUDIO_LIMIT = 8 * 1024 * 1024;
const CONFIG_KEYS = new Set([
  "upstreamProvider",
  "model",
  "modelId",
  "voice",
  "voiceName",
  "voiceId",
  "speakerVoice",
  "speakerVoiceId",
  "apiKey",
  "baseUrl",
  "profileId",
  "outputFormat",
  "responseFormat",
]);
type GoogleSpeechConfig = { model: string; voice: string; responseFormat: "wav" };

function alias(
  raw: Record<string, unknown>,
  names: string[],
  fallback?: string,
): string | undefined {
  const values = names.map((name) => raw[name]).filter((value) => value !== undefined);
  if (values.some((value) => typeof value !== "string" || value !== values[0])) {
    throw new Error("ClawRouter Google speech requires unambiguous model and voice aliases");
  }
  return typeof values[0] === "string" ? values[0] : fallback;
}

function modelTransport(model: string, now = Date.now()) {
  const upstream = model.startsWith("google/") ? model.slice(7) : "";
  if (!GOOGLE_SPEECH_MODELS.some((value) => value === upstream)) {
    throw new Error("ClawRouter Google speech requires an explicit qualified google/model");
  }
  const interactions = upstream.startsWith("gemini-3.8-");
  if (!interactions && now >= PREVIEW_CUTOFF) {
    throw new Error("ClawRouter Google preview speech qualification expired on November 17, 2026");
  }
  return { upstream, interactions };
}

export function readGoogleSpeechConfig(
  raw: Record<string, unknown>,
  fallback?: GoogleSpeechConfig,
): GoogleSpeechConfig {
  if (
    Object.entries(raw).some(([key, value]) => value !== undefined && !CONFIG_KEYS.has(key)) ||
    (fallback && [raw.apiKey, raw.baseUrl, raw.profileId].some((value) => value !== undefined)) ||
    (raw.upstreamProvider !== undefined && raw.upstreamProvider !== "google") ||
    [raw.outputFormat, raw.responseFormat].some((value) => value !== undefined && value !== "wav")
  ) {
    throw new Error(
      "ClawRouter Google speech accepts only model, one voice and WAV output; no raw or speed overrides",
    );
  }
  const model = alias(raw, ["model", "modelId"], fallback?.model) ?? "";
  const voice =
    alias(
      raw,
      ["speakerVoice", "speakerVoiceId", "voice", "voiceName", "voiceId"],
      fallback?.voice,
    ) ?? "";
  modelTransport(model);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(voice)) {
    throw new Error("ClawRouter Google speech requires an explicit single voice");
  }
  return { model, voice, responseFormat: "wav" };
}

function object(value: unknown): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (!record) {
    throw new Error("Invalid ClawRouter Google speech object");
  }
  return record;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error("Invalid ClawRouter Google speech list");
  }
  return value;
}

function pcm(block: Record<string, unknown>, interactions: boolean, maxBytes: number): Buffer {
  if (block.mimeType !== undefined && block.mime_type !== undefined) {
    throw new Error("Ambiguous ClawRouter Google audio MIME");
  }
  // Interactions may omit MIME because this request explicitly fixes raw PCM.
  const mime = block.mimeType ?? block.mime_type ?? (interactions ? "audio/l16" : undefined);
  if (typeof mime !== "string") {
    throw new Error("Missing ClawRouter Google audio MIME");
  }
  const [type, ...parameters] = mime
    .toLowerCase()
    .split(";")
    .map((value) => value.trim());
  if (type !== "audio/l16" && type !== "audio/pcm") {
    throw new Error("ClawRouter Google speech requires raw PCM, not a container");
  }
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const [key, value, extra] = parameter.split("=");
    if (
      key === undefined ||
      extra !== undefined ||
      seen.has(key) ||
      !(
        (key === "codec" && value === "pcm") ||
        (key === "rate" && value === "24000") ||
        (key === "channels" && value === "1")
      )
    ) {
      throw new Error("ClawRouter Google speech requires 24 kHz mono PCM16");
    }
    seen.add(key);
  }
  const data = block.data;
  if (
    typeof data !== "string" ||
    !data.length ||
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
  ) {
    throw new Error("Invalid or oversized ClawRouter Google audio base64");
  }
  const decoded = Buffer.from(data, "base64");
  if (
    decoded.toString("base64") !== data ||
    !decoded.length ||
    decoded.length % 2 ||
    decoded.length > maxBytes ||
    decoded.subarray(0, 4).toString("ascii") === "RIFF"
  ) {
    throw new Error("Invalid ClawRouter Google raw PCM");
  }
  return decoded;
}

function audioResponse(
  payload: unknown,
  upstream: string,
  interactions: boolean,
  maxBytes: number,
): Buffer {
  const body = object(payload),
    blocks: Record<string, unknown>[] = [];
  if (
    body.error !== undefined ||
    body.output_audio !== undefined ||
    body.outputAudio !== undefined
  ) {
    throw new Error("ClawRouter Google speech requires a complete native REST response");
  }
  if (interactions) {
    if (body.status !== "completed" || body.model !== upstream) {
      throw new Error("Incomplete or mismatched ClawRouter Google interaction");
    }
    for (const value of list(body.steps, 1, 64)) {
      const step = object(value);
      if (step.error !== undefined) {
        throw new Error("ClawRouter Google interaction failed");
      }
      for (const value of list(step.content, 0, 64)) {
        const block = object(value);
        if (block.error !== undefined || block.type === "error") {
          throw new Error("ClawRouter Google interaction content failed");
        }
        const audio =
          block.type === "audio" ||
          [block.mime_type, block.mimeType].some(
            (value) => typeof value === "string" && value.toLowerCase().startsWith("audio/"),
          );
        if (audio) {
          if (step.type !== "model_output" || block.type !== "audio") {
            throw new Error("Ambiguous ClawRouter Google audio step");
          }
          blocks.push(block);
        }
      }
    }
  } else {
    if (
      (body.modelVersion !== undefined && body.modelVersion !== upstream) ||
      (body.model !== undefined && body.model !== upstream)
    ) {
      throw new Error("ClawRouter Google speech model mismatch");
    }
    const feedback = body.promptFeedback === undefined ? undefined : object(body.promptFeedback);
    if (
      feedback?.blockReason !== undefined &&
      feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
    ) {
      throw new Error("ClawRouter Google speech was blocked");
    }
    // Multiple candidates are alternative utterances, not consecutive audio.
    const candidate = object(list(body.candidates, 1, 1)[0]);
    if (candidate.finishReason !== "STOP" || candidate.error !== undefined) {
      throw new Error("Incomplete ClawRouter Google speech candidate");
    }
    const content = object(candidate.content);
    if (content.role !== undefined && content.role !== "model") {
      throw new Error("Invalid ClawRouter Google speech role");
    }
    for (const value of list(content.parts, 1, 64)) {
      const part = object(value);
      if (part.error !== undefined) {
        throw new Error("ClawRouter Google speech part failed");
      }
      if (part.inlineData !== undefined && part.inline_data !== undefined) {
        throw new Error("Ambiguous ClawRouter Google audio part");
      }
      const inline = part.inlineData ?? part.inline_data;
      if (inline !== undefined) {
        if (part.thought === true) {
          throw new Error("Ambiguous ClawRouter Google thought audio");
        }
        blocks.push(object(inline));
      }
    }
  }
  if (!blocks.length || blocks.length > 32) {
    throw new Error("Missing or excessive ClawRouter Google audio blocks");
  }
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const part = pcm(block, interactions, maxBytes - 44 - bytes);
    parts.push(part);
    bytes += part.length;
  }
  // Validate every block before allocating or returning the combined WAV.
  const result = Buffer.alloc(44 + bytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + bytes, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(24000, 24);
  result.writeUInt32LE(48000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(bytes, 40);
  let offset = 44;
  for (const part of parts) {
    part.copy(result, offset);
    offset += part.length;
  }
  return result;
}

export async function synthesizeGoogleSpeech(params: {
  request: SpeechSynthesisRequest;
  resolveContext: (
    signal: AbortSignal,
    model: string,
  ) => Promise<ReturnType<typeof resolveClawRouterCapabilityHttpContext>>;
  fetchWithSsrFGuard: PluginCapabilityCatalogContext["fetchWithSsrFGuard"];
  remaining: () => number;
}) {
  const { request: req, remaining } = params;
  req.signal?.throwIfAborted();
  if (req.target === "telephony") {
    throw new Error("ClawRouter Google WAV is not a telephony PCM source");
  }
  const config = readGoogleSpeechConfig(
    req.providerOverrides ?? {},
    readGoogleSpeechConfig(req.providerConfig),
  );
  const { upstream, interactions } = modelTransport(config.model);
  if (!req.text.trim() || req.text.length > 65536 || /\p{Surrogate}/u.test(req.text)) {
    throw new Error("ClawRouter Google speech requires 1-65536 valid UTF-16 text units");
  }
  const body = interactions
    ? {
        model: upstream,
        store: false,
        input: [{ type: "user_input", content: [{ type: "text", text: req.text }] }],
        generation_config: { speech_config: [{ voice: config.voice }] },
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      }
    : {
        contents: [{ role: "user", parts: [{ text: req.text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
        },
      };
  const serialized = JSON.stringify(interactions ? { body } : body);
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error("ClawRouter Google speech request exceeds 256 KiB");
  }
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const maxBytes = Math.min(AUDIO_LIMIT, resolveGeneratedMediaMaxBytes(req.cfg, "audio"));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 46) {
    throw new Error("ClawRouter Google audio limit cannot hold a WAV sample");
  }
  const deadlineSignal = AbortSignal.timeout(remaining());
  const signal = req.signal ? AbortSignal.any([req.signal, deadlineSignal]) : deadlineSignal;
  const http = await params.resolveContext(signal, config.model);
  signal.throwIfAborted();
  remaining();
  http.headers.delete("x-api-key");
  http.headers.delete("x-goog-api-key");
  const { fetchClawRouterCapabilityOffers } = await import("./capability-offers.js");
  const offers = await fetchClawRouterCapabilityOffers({
    context: http,
    timeoutMs: remaining,
    signal,
    requireFreshProxyCatalog: true,
  });
  const endpoint = interactions ? "speech_interactions" : "speech_generate_content";
  const path = interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent";
  const format = "google." + endpoint;
  const eligible = offers.filter(
    (candidate) =>
      candidate.providerId === "google" &&
      candidate.endpoint === endpoint &&
      candidate.path === path &&
      candidate.methods.includes("POST") &&
      candidate.requestFormat === format &&
      candidate.responseFormat === format &&
      candidate.routeKind === (interactions ? "manifest" : "native") &&
      candidate.model?.id === config.model &&
      candidate.model.upstream === upstream &&
      Array.isArray(candidate.model.capabilities) &&
      candidate.model.capabilities.includes("audio.speech"),
  );
  const selected = eligible[0];
  if (!selected || eligible.length !== 1) {
    throw new Error("ClawRouter Google speech requires one eligible supported offer");
  }
  const headers = new Headers(http.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const { mergeSsrFPolicies } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { assertOkOrThrowProviderError } = await import("openclaw/plugin-sdk/provider-http");
  const { readResponseWithLimit } = await import("openclaw/plugin-sdk/response-limit-runtime");
  let attempted = false;
  try {
    const { response, release } = await params.fetchWithSsrFGuard({
      url: selected.url,
      maxRedirects: 0,
      timeoutMs: remaining(),
      init: { method: "POST", headers, body: serialized, signal },
      beforeRequest: () => {
        signal.throwIfAborted();
        remaining();
        modelTransport(config.model);
        attempted = true;
      },
      policy: mergeSsrFPolicies(
        http.ssrfPolicy,
        http.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: http.dispatcherPolicy,
      auditContext: "clawrouter.google.speech",
    });
    try {
      await assertOkOrThrowProviderError(response, "ClawRouter Google speech error", {
        requestHeaders: headers,
        signal,
        bodyTimeoutMs: remaining,
      });
      const encoding = response.headers.get("content-encoding");
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.has("content-range") ||
        (encoding !== null && encoding.trim().toLowerCase() !== "identity") ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        throw new Error("ClawRouter Google speech requires a complete JSON response");
      }
      const bytes = await readResponseWithLimit(
        response,
        Math.ceil((maxBytes - 44) / 3) * 4 + 65536,
        { timeoutMs: remaining, chunkTimeoutMs: 30_000, signal },
      );
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== bytes.length)) {
        throw new Error("Incomplete ClawRouter Google speech JSON");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("Malformed ClawRouter Google speech JSON");
      }
      const audioBuffer = audioResponse(payload, upstream, interactions, maxBytes);
      remaining();
      signal.throwIfAborted();
      return { audioBuffer, outputFormat: "wav", fileExtension: ".wav", voiceCompatible: false };
    } finally {
      // Preserve the shared transport owner's release ordering; this is not a
      // claim that fire-and-forget cancellation proves physical quiescence.
      void response.body?.cancel().catch(() => undefined);
      await release();
    }
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("ClawRouter Google speech failed", { cause: error });
    if (attempted) {
      recordModelFallbackStop(failure);
    }
    throw failure;
  }
}
