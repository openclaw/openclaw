import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
} from "openclaw/plugin-sdk/media-understanding";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TOKENS = 4096;

function resolveTimeoutMs(requested?: number): number {
  return typeof requested === "number" && requested > 0 ? requested : 30_000;
}

function buildOpenAiVisionBody(
  model: string,
  prompt: string,
  images: Array<{ buffer: Buffer; mime?: string }>,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((img) => ({
            type: "image_url",
            image_url: {
              url: `data:${img.mime ?? "image/jpeg"};base64,${img.buffer.toString("base64")}`,
            },
          })),
        ],
      },
    ],
  };
}

function extractText(response: Record<string, unknown>): string {
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) {
    throw new Error("OpenRouter vision: no choices returned");
  }
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  if (!message) {
    throw new Error("OpenRouter vision: no message in response");
  }
  const content = message.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
    if (text) return text;
  }
  throw new Error("OpenRouter vision: no text content in response");
}

export const openRouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["image"],

  async describeImage(params: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    return this.describeImages!({
      images: [{ buffer: params.buffer, fileName: params.fileName, mime: params.mime }],
      model: params.model,
      provider: params.provider,
      prompt: params.prompt,
      maxTokens: params.maxTokens,
      timeoutMs: params.timeoutMs,
      profile: params.profile,
      preferredProfile: params.preferredProfile,
      agentDir: params.agentDir,
      cfg: params.cfg,
    });
  },

  async describeImages(params: ImagesDescriptionRequest): Promise<ImagesDescriptionResult> {
    const baseUrl = normalizeBaseUrl(
      (params.cfg?.models?.providers?.openrouter as { baseUrl?: string } | undefined)?.baseUrl,
      OPENROUTER_BASE_URL,
    );
    const apiKey =
      params.cfg?.models?.providers?.openrouter?.apiKey ??
      process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      throw new Error("OpenRouter vision: no API key found");
    }

    const prompt = params.prompt ?? "Describe the image.";
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = resolveTimeoutMs(params.timeoutMs);

    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    });

    const body = buildOpenAiVisionBody(params.model, prompt, params.images, maxTokens);
    const res = await postJsonRequest({
      url: `${baseUrl}/chat/completions`,
      headers,
      body,
      timeoutMs,
      fetchFn: fetch,
    });
    await assertOkOrThrowHttpError(res, `${baseUrl}/chat/completions`);
    const json = (await res.json()) as Record<string, unknown>;
    const text = extractText(json);

    return { text, model: params.model };
  },
};
