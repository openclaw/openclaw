import path from "node:path";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const DEFAULT_OPENROUTER_AUDIO_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_AUDIO_MODEL = "google/gemini-3-flash-preview";
const DEFAULT_OPENROUTER_AUDIO_PROMPT = "Please transcribe this audio file.";

type OpenRouterChatCompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

function resolveAudioFormat(params: { mime?: string; fileName?: string }): string {
  const mime = params.mime?.trim().toLowerCase();
  if (mime === "audio/mpeg") {
    return "mp3";
  }
  if (
    mime === "audio/mp4" ||
    mime === "audio/x-m4a" ||
    mime === "audio/m4a" ||
    mime === "audio/aac"
  ) {
    return mime === "audio/aac" ? "aac" : "m4a";
  }
  if (mime === "audio/flac") {
    return "flac";
  }
  if (mime === "audio/ogg" || mime === "audio/opus") {
    return "ogg";
  }
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") {
    return "wav";
  }
  if (mime === "audio/aiff" || mime === "audio/x-aiff") {
    return "aiff";
  }

  const ext = path
    .extname(params.fileName ?? "")
    .replace(/^\./, "")
    .trim()
    .toLowerCase();
  if (ext === "mp3") {
    return "mp3";
  }
  if (ext === "m4a" || ext === "mp4") {
    return "m4a";
  }
  if (ext === "aac") {
    return "aac";
  }
  if (ext === "flac") {
    return "flac";
  }
  if (ext === "ogg" || ext === "oga" || ext === "opus") {
    return "ogg";
  }
  if (ext === "wav" || ext === "wave") {
    return "wav";
  }
  if (ext === "aiff" || ext === "aif") {
    return "aiff";
  }
  return "wav";
}

function resolvePrompt(params: { prompt?: string; language?: string }): string {
  const trimmedPrompt = params.prompt?.trim();
  const trimmedLanguage = params.language?.trim();
  if (trimmedPrompt && trimmedLanguage) {
    return `${trimmedPrompt}\nExpected language: ${trimmedLanguage}.`;
  }
  if (trimmedPrompt) {
    return trimmedPrompt;
  }
  if (trimmedLanguage) {
    return `${DEFAULT_OPENROUTER_AUDIO_PROMPT}\nExpected language: ${trimmedLanguage}.`;
  }
  return DEFAULT_OPENROUTER_AUDIO_PROMPT;
}

function coerceOpenRouterText(payload: OpenRouterChatCompletionPayload): string | null {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

export async function transcribeOpenRouterAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENROUTER_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const headers = new Headers(params.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const body = {
    model,
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: resolvePrompt(params) },
          {
            type: "input_audio",
            input_audio: {
              data: params.buffer.toString("base64"),
              format: resolveAudioFormat(params),
            },
          },
        ],
      },
    ],
  };

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");
    const payload = (await res.json()) as OpenRouterChatCompletionPayload;
    const text = coerceOpenRouterText(payload);
    if (!text) {
      throw new Error("Audio transcription response missing text");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["audio"],
  transcribeAudio: transcribeOpenRouterAudio,
};
