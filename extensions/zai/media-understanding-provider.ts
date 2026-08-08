// Zai provider module implements model/runtime integration.
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
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { ZAI_GLOBAL_BASE_URL } from "./model-definitions.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const ZAI_MEDIA_METADATA = manifest.mediaUnderstandingProviderMetadata.zai;
const DEFAULT_ZAI_VIDEO_PROMPT = "Describe the video.";
const ZAI_VIDEO_ERROR_LABEL = "Z.AI video description failed";

async function describeZaiVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult> {
  const model = resolveMediaUnderstandingString(
    params.model,
    ZAI_MEDIA_METADATA.defaultModels.video,
  );
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: ZAI_GLOBAL_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "zai",
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: buildOpenAiCompatibleVideoRequestBody({
      model,
      prompt: resolveMediaUnderstandingString(params.prompt, DEFAULT_ZAI_VIDEO_PROMPT),
      mime: resolveMediaUnderstandingString(params.mime, "video/mp4"),
      buffer: params.buffer,
    }),
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn: params.fetchFn ?? fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(response, ZAI_VIDEO_ERROR_LABEL);
    const payload = await readProviderJsonResponse<OpenAiCompatibleVideoPayload>(
      response,
      ZAI_VIDEO_ERROR_LABEL,
    );
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Z.AI video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export const zaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "zai",
  capabilities: ["image", "video"],
  defaultModels: ZAI_MEDIA_METADATA.defaultModels,
  autoPriority: ZAI_MEDIA_METADATA.autoPriority,
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeZaiVideo,
};
