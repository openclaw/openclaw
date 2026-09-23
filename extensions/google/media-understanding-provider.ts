import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  readProviderJsonResponse,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import {
  createGoogleMediaUnderstandingProviderMetadata,
  GOOGLE_MEDIA_UNDERSTANDING_DEFAULT_MODELS,
} from "./generation-provider-metadata.js";
import {
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiHttpRequestConfig,
} from "./runtime-api.js";

const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

async function generateGeminiInlineDataText(params: {
  buffer: Buffer;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  defaultModel: string;
  defaultPrompt: string;
  defaultMime: string;
  httpErrorLabel: string;
  missingTextError: string;
}): Promise<{ text: string; model: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = (() => {
    const trimmed = params.model?.trim();
    if (!trimmed) {
      return params.defaultModel;
    }
    return normalizeGoogleModelId(trimmed);
  })();
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      headers: params.headers,
      request: params.request,
      capability: params.defaultMime.startsWith("audio/") ? "audio" : "video",
      transport: "media-understanding",
    });
  const url = `${baseUrl}/models/${model}:generateContent`;

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
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowProviderError(res, params.httpErrorLabel);

    const payload = await readProviderJsonResponse<{
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    }>(res, params.httpErrorLabel);
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
    defaultModel: GOOGLE_MEDIA_UNDERSTANDING_DEFAULT_MODELS.audio,
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
    defaultModel: GOOGLE_MEDIA_UNDERSTANDING_DEFAULT_MODELS.video,
    defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
    defaultMime: "video/mp4",
    httpErrorLabel: "Video description failed",
    missingTextError: "Video description response missing text",
  });
  return { text, model };
}

export const googleMediaUnderstandingProvider: MediaUnderstandingProvider = {
  ...createGoogleMediaUnderstandingProviderMetadata(),
  transcribeAudio: transcribeGeminiAudio,
  describeVideo: describeGeminiVideo,
};
