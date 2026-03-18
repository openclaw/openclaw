import {
  assertOkOrThrowHttpError,
  describeImageWithModel,
  describeImagesWithModel,
  normalizeBaseUrl,
  postJsonRequest,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { normalizeGoogleModelId, parseGeminiAuth } from "../runtime-api.js";

export const DEFAULT_GOOGLE_AUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

async function generateGeminiInlineDataText(params: {
  buffer: Buffer;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultPrompt: string;
  defaultMime: string;
  httpErrorLabel: string;
  missingTextError: string;
}): Promise<{ text: string; model: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const model = (() => {
    const trimmed = params.model?.trim();
    if (!trimmed) {
      return params.defaultModel;
    }
    return normalizeGoogleModelId(trimmed);
  })();
  const url = `${baseUrl}/models/${model}:generateContent`;

  const authHeaders = parseGeminiAuth(params.apiKey);
  const headers = new Headers(params.headers);
  for (const [key, value] of Object.entries(authHeaders.headers)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const prompt = (() => {
    const trimmed = params.prompt?.trim();
    return trimmed || params.defaultPrompt;
  })();

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: params.mime ?? params.defaultMime,
              data: params.buffer.toString("base64"),
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
    await assertOkOrThrowHttpError(res, params.httpErrorLabel);

    const payload = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part) => part?.text?.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      throw new Error(params.missingTextError);
    }
    return { text, model };
  } finally {
    await release();
  }
}

export async function transcribeGeminiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_AUDIO_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
    defaultMime: "audio/wav",
    httpErrorLabel: "Audio transcription failed",
    missingTextError: "Audio transcription response missing text",
  });
  return { text, model };
}

export async function describeGeminiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_VIDEO_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
    defaultMime: "video/mp4",
    httpErrorLabel: "Video description failed",
    missingTextError: "Video description response missing text",
  });
  return { text, model };
}

export const googleMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeGeminiAudio,
  describeVideo: describeGeminiVideo,
};
