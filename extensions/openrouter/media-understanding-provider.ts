import path from "node:path";
import { normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import {
  postJsonResponse,
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
  async transcribeAudio(params) {
    const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL;
    let format = AUDIO_FORMAT_BY_MIME.get(normalizeMimeType(params.mime) ?? "");
    if (format === undefined) {
      const ext = path
        .extname(params.fileName ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
      if (ext === "mpeg") {
        format = "mp3";
      } else if (ext === "mp4") {
        format = "m4a";
      } else if (ext === "oga" || ext === "opus") {
        format = "ogg";
      } else {
        format = SUPPORTED_AUDIO_FORMATS.has(ext) ? ext : undefined;
      }
    }
    if (!format) {
      throw new Error(
        `OpenRouter STT could not resolve audio format from mime "${params.mime ?? ""}" and file "${params.fileName ?? ""}"`,
      );
    }
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

    const payload = await postJsonResponse({
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
      errorLabel: "OpenRouter audio transcription failed",
      responseLabel: "openrouter.stt",
      objectResponse: true,
    });
    return {
      text: requireTranscriptionText(
        payload.text,
        "OpenRouter transcription response missing text",
      ),
      model,
    };
  },
};
