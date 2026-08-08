// StepFun provider module implements video/runtime integration.
import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
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
import { STEPFUN_PROVIDER_ID } from "./provider-catalog.js";

const DEFAULT_STEPFUN_VIDEO_BASE_URL = "https://api.stepfun.ai/v1";
const DEFAULT_STEPFUN_VIDEO_MODEL = "step-3.7-flash";
const DEFAULT_STEPFUN_VIDEO_PROMPT = "Describe the video content concisely.";

export async function describeStepfunVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_STEPFUN_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_STEPFUN_VIDEO_PROMPT);

  const baseUrl =
    typeof params.baseUrl === "string" ? params.baseUrl.trim() : DEFAULT_STEPFUN_VIDEO_BASE_URL;

  const { allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl,
      defaultBaseUrl: DEFAULT_STEPFUN_VIDEO_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: STEPFUN_PROVIDER_ID,
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });

  const url = `${baseUrl}/chat/completions`;

  const body = buildOpenAiCompatibleVideoRequestBody({
    model,
    prompt,
    mime,
    buffer: params.buffer,
  });

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
    await assertOkOrThrowHttpError(res, "Step 3.7 Flash video description failed");
    const payload = await readProviderJsonResponse<OpenAiCompatibleVideoPayload>(
      res,
      "Step 3.7 Flash video description failed",
    );
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Step 3.7 Flash video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export const stepfunMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: STEPFUN_PROVIDER_ID,
  capabilities: ["image", "video"],
  defaultModels: {
    image: "step-3.7-flash",
    video: DEFAULT_STEPFUN_VIDEO_MODEL,
  },
  autoPriority: { video: 20 },
  describeVideo: describeStepfunVideo,
};
