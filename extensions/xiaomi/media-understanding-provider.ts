import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
} from "openclaw/plugin-sdk/media-understanding";

export const DEFAULT_XIAOMI_VIDEO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_XIAOMI_VIDEO_MODEL = "mimo-v2-omni";
const DEFAULT_XIAOMI_VIDEO_PROMPT = "Describe the video.";

type XiaomiVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
      reasoning_content?: string;
    };
  }>;
};

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_XIAOMI_VIDEO_MODEL;
}

function resolvePrompt(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed || DEFAULT_XIAOMI_VIDEO_PROMPT;
}

function coerceResponseText(payload: XiaomiVideoPayload): string | null {
  const message = payload.choices?.[0]?.message;
  if (!message) {
    return null;
  }
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  return null;
}

export async function describeXiaomiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_XIAOMI_VIDEO_BASE_URL);
  const model = resolveModel(params.model);
  const mime = params.mime ?? "video/mp4";
  const prompt = resolvePrompt(params.prompt);
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
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "video_url",
            video_url: {
              url: `data:${mime};base64,${params.buffer.toString("base64")}`,
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
  });

  try {
    await assertOkOrThrowHttpError(res, "Xiaomi video description failed");
    const payload = (await res.json()) as XiaomiVideoPayload;
    const text = coerceResponseText(payload);
    if (!text) {
      throw new Error("Xiaomi video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export const xiaomiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "xiaomi",
  capabilities: ["image", "video"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeXiaomiVideo,
};
