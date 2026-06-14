// Qwen provider module implements model/runtime integration.
import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  describeImageWithModel,
  describeImagesWithModel,
  resolveMediaUnderstandingString,
  type MediaUnderstandingProvider,
  type OpenAiCompatibleVideoPayload,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_IMAGE_MODEL = "qwen-vl-max-latest";
const DEFAULT_QWEN_VIDEO_MODEL = "qwen-vl-max-latest";
const DEFAULT_QWEN_VIDEO_PROMPT = "Describe the video in detail.";
export const QWEN_MEDIA_UNDERSTANDING_PROVIDER_IDS = [
  "qwen",
  "qwencloud",
  "modelstudio",
  "dashscope",
] as const;

export async function describeQwenVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_QWEN_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_QWEN_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "qwen",
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });

  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: buildOpenAiCompatibleVideoRequestBody({
      model,
      prompt,
      mime,
      buffer: params.buffer,
    }),
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Qwen video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Qwen video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export function buildQwenMediaUnderstandingProvider(
  id: (typeof QWEN_MEDIA_UNDERSTANDING_PROVIDER_IDS)[number] = "qwen",
): MediaUnderstandingProvider {
  return {
    id,
    capabilities: ["image", "video"],
    defaultModels: {
      image: DEFAULT_QWEN_IMAGE_MODEL,
      video: DEFAULT_QWEN_VIDEO_MODEL,
    },
    modelCapabilityOverrides: {
      nonImageModelFamilies: ["qwen3.7-max"],
    },
    ...(id === "qwen" ? { autoPriority: { video: 15 } } : {}),
    describeImage: describeImageWithModel,
    describeImages: describeImagesWithModel,
    describeVideo: describeQwenVideo,
  };
}
