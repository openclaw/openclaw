import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowProviderError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import type {
  ClawRouterCapabilityOffer,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";

type MultipartProvider = "groq" | "mistral";
type AudioInput = Pick<
  AudioTranscriptionRequest,
  "buffer" | "fileName" | "mime" | "language" | "prompt" | "signal"
>;
const uploadMimes: Record<string, readonly string[]> = {
  flac: ["audio/flac", "audio/x-flac"],
  mp3: ["audio/mpeg", "audio/mp3"],
  mp4: ["audio/mp4", "video/mp4"],
  mpeg: ["audio/mpeg"],
  mpga: ["audio/mpeg"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  ogg: ["audio/ogg", "application/ogg"],
  wav: ["audio/wav", "audio/wave", "audio/x-wav"],
  webm: ["audio/webm", "video/webm"],
};

export function validateClawRouterMultipartAudio(provider: MultipartProvider, input: AudioInput) {
  const types = uploadMimes[input.fileName.split(".").at(-1)?.toLowerCase() ?? ""];
  const mime = input.mime?.trim().toLowerCase() || "application/octet-stream";
  if (!types || (mime !== "application/octet-stream" && !types.includes(mime))) {
    throw new Error("ClawRouter transcription filename and MIME are unsupported");
  }
  if (input.language?.trim() && !/^[a-z]{2}$/.test(input.language.trim())) {
    throw new Error("ClawRouter transcription requires a two-letter lowercase language");
  }
  if (provider === "mistral" && input.prompt?.trim()) {
    throw new Error("ClawRouter Mistral transcription does not support prompt");
  }
  if (Buffer.byteLength(input.prompt?.trim() ?? "", "utf8") > 4096) {
    throw new Error("ClawRouter Groq transcription prompt exceeds 4 KiB");
  }
}

export async function transcribeClawRouterMultipartAudio(params: {
  input: AudioInput;
  offer: ClawRouterCapabilityOffer;
  model: string;
  upstreamModel: string;
  http: ReturnType<typeof resolveClawRouterCapabilityHttpContext>;
  remaining: () => number;
  fetchFn: typeof fetch;
}) {
  const { input, offer, http, remaining } = params;
  const body = buildAudioTranscriptionFormData({
    ...input,
    fields: {
      // Manifest intake selects a catalog card; native intake accepts its upstream identity.
      model: offer.routeKind === "manifest" ? params.model : params.upstreamModel,
      language: input.language,
      prompt: input.prompt,
    },
  });
  const { response, release } = await postTranscriptionRequest({
    ...http,
    url: offer.url,
    body,
    timeoutMs: remaining(),
    signal: input.signal,
    fetchFn: params.fetchFn,
  });
  try {
    await assertOkOrThrowProviderError(response, "ClawRouter transcription failed", {
      signal: input.signal,
      bodyTimeoutMs: remaining(),
      requestHeaders: http.headers,
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.has("content-range") ||
      ![null, "identity"].includes(response.headers.get("content-encoding")) ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    ) {
      await response.body?.cancel();
      throw new Error("ClawRouter transcription requires a complete JSON response");
    }
    const payload = await readProviderJsonObjectResponse(response, "ClawRouter transcription", {
      maxBytes: 1024 * 1024,
      signal: input.signal,
      timeoutMs: remaining(),
      requestHeaders: http.headers,
    });
    const text = requireTranscriptionText(
      payload.text,
      "ClawRouter transcription response missing text",
    );
    if (
      !text ||
      text.length > 262144 ||
      payload.error !== undefined ||
      (payload.finish_reason != null && payload.finish_reason !== "stop")
    ) {
      throw new Error("ClawRouter transcription response is incomplete or malformed");
    }
    input.signal?.throwIfAborted();
    return { text, model: params.model };
  } finally {
    await release();
  }
}
