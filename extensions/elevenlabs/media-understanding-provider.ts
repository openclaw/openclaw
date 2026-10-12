import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

// Synchronous transcription options that are safe to forward from
// providerOptions (audio defaults / model entry) into the multipart body.
// These keys do not change the response contract: the provider still expects
// a `payload.text` string. Options that alter the response (e.g. `webhook`,
// `use_multi_channel`) are intentionally excluded from the allowlist.
const ELEVENLABS_SYNC_TRANSCRIPTION_OPTIONS = [
  "no_verbatim",
  "tag_audio_events",
  "diarize",
] as const;

async function transcribeElevenLabsAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }

  const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
      defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
      headers: req.headers,
      request: req.request,
      defaultHeaders: {
        "xi-api-key": apiKey,
      },
      provider: "elevenlabs",
      api: "elevenlabs-speech-to-text",
      capability: "audio",
      transport: "media-understanding",
    });
  const fields: Record<string, string | number | boolean | undefined> = {
    model_id: model,
    language_code: req.language,
    prompt: req.prompt,
  };
  for (const key of ELEVENLABS_SYNC_TRANSCRIPTION_OPTIONS) {
    const value = req.query?.[key];
    if (value !== undefined) {
      // Avoid duplicating a key that the caller already pinned via the
      // dedicated fields above; the allowlist keys never collide with
      // model_id/language_code/prompt, so this simply forwards the option.
      fields[key] = value;
    }
  }
  const form = buildAudioTranscriptionFormData({
    buffer: req.buffer,
    fileName: req.fileName,
    mime: req.mime,
    fields,
  });
  const { response, release } = await postTranscriptionRequest({
    url: `${baseUrl}/v1/speech-to-text`,
    headers,
    body: form,
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "elevenlabs speech-to-text",
  });

  try {
    await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
    const payload = await readProviderJsonObjectResponse(
      response,
      "ElevenLabs audio transcription failed",
    );
    const text = requireTranscriptionText(
      typeof payload.text === "string" ? payload.text : undefined,
      "ElevenLabs audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}

export const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "elevenlabs",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
  autoPriority: { audio: 45 },
  transcribeAudio: transcribeElevenLabsAudio,
};
