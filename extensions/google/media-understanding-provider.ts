import {
  describeImageWithModel,
  describeImagesWithModel,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleModelId,
  parseGeminiAuth,
} from "./api.js";

export const DEFAULT_GOOGLE_AUDIO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
export const DEFAULT_GOOGLE_VIDEO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

/**
 * Browser-safe environment variable reader.
 */
function readProviderEnvValue(envVars: string[]): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) {
    return undefined;
  }
  for (const envVar of envVars) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveGoogleBaseUrl(baseUrl?: string): string {
  const fromEnv = readProviderEnvValue([
    "GOOGLE_GEMINI_ENDPOINT",
    "GEMINI_BASE_URL",
    "GOOGLE_GEMINI_BASE_URL",
  ]);
  return normalizeGoogleApiBaseUrl(baseUrl || fromEnv);
}

function resolveGoogleApiType(
  baseUrl: string,
  apiTypeOverride?: string,
): "gemini" | "openai-compatible" {
  const envApiType = readProviderEnvValue(["GEMINI_API_TYPE"]);
  if (apiTypeOverride === "openai-compatible" || envApiType === "openai-compatible") {
    return "openai-compatible";
  }
  if (
    !baseUrl.includes("googleapis.com") &&
    (baseUrl.endsWith("/v1") || baseUrl.includes("/v1/"))
  ) {
    return "openai-compatible";
  }
  return "gemini";
}

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
  fetchFn?: typeof fetch;
  defaultBaseUrl: string;
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

  const rawBaseUrl = resolveGoogleBaseUrl(params.baseUrl ?? params.defaultBaseUrl);
  const apiType = resolveGoogleApiType(
    rawBaseUrl,
    (params.request as Record<string, unknown> | undefined)?.apiType as
      | "gemini"
      | "openai-compatible"
      | undefined,
  );

  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: rawBaseUrl,
      defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
      allowPrivateNetwork: true,
      headers: params.headers,
      request: params.request,
      defaultHeaders: parseGeminiAuth(params.apiKey).headers,
      provider: "google",
      api: "google-generative-ai",
      capability: params.defaultMime.startsWith("audio/") ? "audio" : "video",
      transport: "media-understanding",
    });

  const prompt = (() => {
    const trimmed = params.prompt?.trim();
    return trimmed || params.defaultPrompt;
  })();

  if (apiType === "openai-compatible") {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Authorization", `Bearer ${params.apiKey}`);

    const { response: res, release } = await postJsonRequest({
      url: endpoint,
      headers: requestHeaders,
      body: {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${params.mime ?? params.defaultMime};base64,${params.buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      },
      timeoutMs: params.timeoutMs,
      fetchFn,
      allowPrivateNetwork,
      dispatcherPolicy,
    });

    try {
      await assertOkOrThrowHttpError(res, params.httpErrorLabel);
      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error(params.missingTextError);
      }
      return { text, model };
    } finally {
      await release();
    }
  }

  const url = `${baseUrl}/models/${model}:generateContent`;
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
    allowPrivateNetwork,
    dispatcherPolicy,
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
  defaultModels: {
    image: DEFAULT_GOOGLE_VIDEO_MODEL,
    audio: DEFAULT_GOOGLE_AUDIO_MODEL,
    video: DEFAULT_GOOGLE_VIDEO_MODEL,
  },
  autoPriority: { image: 30, audio: 40, video: 10 },
  nativeDocumentInputs: ["pdf"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeGeminiAudio,
  describeVideo: describeGeminiVideo,
};
