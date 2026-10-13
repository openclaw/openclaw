import path from "node:path";
import { normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
const SUPPORTED_AUDIO_FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);

const AUDIO_FORMAT_BY_MIME = new Map([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/flac", "flac"],
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/ogg", "ogg"],
  ["audio/oga", "ogg"],
  ["audio/opus", "ogg"],
  ["audio/webm", "webm"],
  ["audio/aac", "aac"],
]);

function resolveFormatFromFileName(fileName?: string): string | undefined {
  const ext = path
    .extname(fileName ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!ext) {
    return undefined;
  }
  if (ext === "mpeg") {
    return "mp3";
  }
  if (ext === "mp4") {
    return "m4a";
  }
  if (ext === "oga" || ext === "opus") {
    return "ogg";
  }
  return SUPPORTED_AUDIO_FORMATS.has(ext) ? ext : undefined;
}

function resolveOpenRouterAudioFormat(params: { mime?: string; fileName?: string }): string {
  const format =
    AUDIO_FORMAT_BY_MIME.get(normalizeMimeType(params.mime) ?? "") ??
    resolveFormatFromFileName(params.fileName);
  if (format) {
    return format;
  }
  throw new Error(
    `OpenRouter STT could not resolve audio format from mime "${params.mime ?? ""}" and file "${params.fileName ?? ""}"`,
  );
}

type OpenRouterSttResponse = {
  text?: string;
};

async function transcribeOpenRouterAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL;
  const format = resolveOpenRouterAudioFormat({
    mime: params.mime,
    fileName: params.fileName,
  });
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: OPENROUTER_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      provider: "openrouter",
      api: "openrouter-stt",
      capability: "audio",
      transport: "media-understanding",
    });
  const temperature = asFiniteNumber(params.query?.temperature);

  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/audio/transcriptions`,
    headers,
    body: {
      model,
      input_audio: {
        data: params.buffer.toString("base64"),
        format,
      },
      ...(params.language?.trim() ? { language: params.language.trim() } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "openrouter stt",
  });

  try {
    await assertOkOrThrowHttpError(response, "OpenRouter audio transcription failed");
    const payload = await readProviderJsonResponse<OpenRouterSttResponse>(
      response,
      "openrouter.stt",
    );
    return {
      text: requireTranscriptionText(
        payload.text,
        "OpenRouter transcription response missing text",
      ),
      model,
    };
  } finally {
    await release();
  }
}

export const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: "auto",
    audio: DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: {
    audio: 35,
  },
  describeImage: undefined,
  describeImages: undefined,
  transcribeAudio: transcribeOpenRouterAudio,
};
