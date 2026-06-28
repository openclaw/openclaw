// Openrouter provider module implements model/runtime integration.
import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  resolveInlineImageJsonResponseMaxBytes,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { MAX_IMAGE_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_RESULTS = 4;
const MAX_CHAT_COMPLETIONS_INPUT_IMAGES = 5;
const MB = 1024 * 1024;
const SUPPORTED_MODELS = [
  DEFAULT_MODEL,
  "google/gemini-3.1-flash-image",
  "google/gemini-3-pro-image",
  "google/gemini-3-pro-image-preview",
  "google/gemini-2.5-flash-image",
  "openai/gpt-5-image",
  "openai/gpt-5-image-mini",
  "openai/gpt-5.4-image-2",
  "microsoft/mai-image-2.5",
] as const;
const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
] as const;
const MAX_IMAGES_API_INPUT_REFERENCES = 10;
type OpenRouterImagesApiModelCapabilities = {
  maxCount: number;
  maxInputImages: number;
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
};
const GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
const OPENROUTER_IMAGES_API_MODEL_CAPABILITIES: Record<
  string,
  OpenRouterImagesApiModelCapabilities
> = {
  "google/gemini-3.1-flash-image": {
    maxCount: 1,
    maxInputImages: MAX_IMAGES_API_INPUT_REFERENCES,
    aspectRatios: [...GEMINI_IMAGE_ASPECT_RATIOS, "1:4", "1:8", "4:1", "8:1"],
    resolutions: ["1K", "2K", "4K"],
  },
  "google/gemini-3-pro-image": {
    maxCount: 1,
    maxInputImages: MAX_IMAGES_API_INPUT_REFERENCES,
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
    resolutions: ["1K", "2K", "4K"],
  },
  "google/gemini-2.5-flash-image": {
    maxCount: 1,
    maxInputImages: 3,
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  },
  "openai/gpt-5-image": {
    maxCount: MAX_IMAGE_RESULTS,
    maxInputImages: MAX_IMAGES_API_INPUT_REFERENCES,
  },
  "openai/gpt-5-image-mini": {
    maxCount: MAX_IMAGE_RESULTS,
    maxInputImages: MAX_IMAGES_API_INPUT_REFERENCES,
  },
  "microsoft/mai-image-2.5": {
    maxCount: 1,
    maxInputImages: 1,
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
  },
};
const DEDICATED_IMAGE_API_MODELS = new Set<string>(
  Object.keys(OPENROUTER_IMAGES_API_MODEL_CAPABILITIES),
);
const OPENROUTER_IMAGE_MALFORMED_RESPONSE = "OpenRouter image generation response malformed";

function throwMalformedOpenRouterImageResponse(message: string | undefined): never | undefined {
  if (message) {
    throw new Error(message);
  }
  return undefined;
}

function pushDataUrlImage(
  images: GeneratedImageAsset[],
  dataUrl: string,
  malformedResponseError?: string,
): void {
  const image = generatedImageAssetFromDataUrl({ dataUrl, index: images.length });
  if (!image) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  images.push(image);
}

function extractImagesFromPart(
  images: GeneratedImageAsset[],
  part: unknown,
  malformedResponseError?: string,
): void {
  if (!isRecord(part)) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  if (part.type === "text") {
    return;
  }
  if (part.type === "image_url") {
    const imageUrl = part.image_url ?? part.imageUrl;
    if (!isRecord(imageUrl)) {
      throwMalformedOpenRouterImageResponse(malformedResponseError);
      return;
    }
    const url = normalizeOptionalString(imageUrl.url);
    if (url) {
      pushDataUrlImage(images, url, malformedResponseError);
      return;
    }
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }

  const rawBase64 = normalizeOptionalString(part.b64_json);
  if (rawBase64) {
    const image = generatedImageAssetFromBase64({ base64: rawBase64, index: images.length });
    if (image) {
      images.push(image);
      return;
    }
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  if ("b64_json" in part) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }

  const inlineData = part.inlineData ?? part.inline_data;
  if (inlineData === undefined || inlineData === null) {
    return;
  }
  if (!isRecord(inlineData)) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  const data = normalizeOptionalString(inlineData.data);
  if (!data) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  const mimeType =
    normalizeOptionalString(inlineData.mimeType) ??
    normalizeOptionalString(inlineData.mime_type) ??
    "image/png";
  const image = generatedImageAssetFromBase64({
    base64: data,
    index: images.length,
    mimeType,
  });
  if (image) {
    images.push(image);
    return;
  }
  throwMalformedOpenRouterImageResponse(malformedResponseError);
}

function extractImagesFromDataArray(
  images: GeneratedImageAsset[],
  data: unknown,
  malformedResponseError?: string,
): boolean {
  if (data === undefined || data === null) {
    return false;
  }
  if (!Array.isArray(data)) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return true;
  }
  for (const entry of data) {
    if (!isRecord(entry)) {
      throwMalformedOpenRouterImageResponse(malformedResponseError);
      continue;
    }
    const rawBase64 = normalizeOptionalString(entry.b64_json);
    if (!rawBase64) {
      throwMalformedOpenRouterImageResponse(malformedResponseError);
      continue;
    }
    const image = generatedImageAssetFromBase64({
      base64: rawBase64,
      index: images.length,
      mimeType: normalizeOptionalString(entry.media_type),
    });
    if (!image) {
      throwMalformedOpenRouterImageResponse(malformedResponseError);
      continue;
    }
    images.push(image);
  }
  return true;
}

export function extractOpenRouterImagesFromResponse(
  body: unknown,
  options: { malformedResponseError?: string } = {},
): GeneratedImageAsset[] {
  if (!isRecord(body)) {
    throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    return [];
  }
  const images: GeneratedImageAsset[] = [];
  if (extractImagesFromDataArray(images, body.data, options.malformedResponseError)) {
    return images;
  }
  const choices = body.choices;
  if (choices === undefined || choices === null) {
    return [];
  }
  if (!Array.isArray(choices)) {
    throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    return [];
  }

  for (const choice of choices) {
    if (!isRecord(choice)) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
      continue;
    }
    const message = choice.message;
    if (message === undefined || message === null) {
      continue;
    }
    if (!isRecord(message)) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
      continue;
    }

    const messageImages = message.images;
    if (messageImages !== undefined && messageImages !== null) {
      if (!Array.isArray(messageImages)) {
        throwMalformedOpenRouterImageResponse(options.malformedResponseError);
        continue;
      }
      for (const entry of messageImages) {
        if (!isRecord(entry)) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        const imageUrl = entry.image_url ?? entry.imageUrl;
        if (!isRecord(imageUrl)) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        const url = normalizeOptionalString(imageUrl.url);
        if (!url) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        pushDataUrlImage(images, url, options.malformedResponseError);
      }
    }

    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      const dataUrlPattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      for (const match of content.matchAll(dataUrlPattern)) {
        pushDataUrlImage(images, match[0]);
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        extractImagesFromPart(images, part, options.malformedResponseError);
      }
    } else if (content !== undefined && content !== null) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    }
  }
  return images;
}

function resolveImageCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return 1;
  }
  return Math.max(1, Math.min(MAX_IMAGE_RESULTS, Math.trunc(count)));
}

function resolveGeneratedImageMaxBytes(req: {
  cfg: { agents?: { defaults?: { mediaMaxMb?: number } } };
}): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MB);
  }
  return MAX_IMAGE_BYTES;
}

function isGeminiImageModel(model: string): boolean {
  return model.startsWith("google/gemini-");
}

function buildMessageContent(
  req: ImageGenerationRequest,
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const inputImages = req.inputImages ?? [];
  if (inputImages.length === 0) {
    return req.prompt;
  }
  return [
    { type: "text", text: req.prompt },
    ...inputImages.map((image) => ({
      type: "image_url" as const,
      image_url: { url: toImageDataUrl(image) },
    })),
  ];
}

function buildImageConfig(req: ImageGenerationRequest, model: string): Record<string, string> {
  if (!isGeminiImageModel(model)) {
    return {};
  }
  const imageConfig: Record<string, string> = {};
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    imageConfig.aspect_ratio = aspectRatio;
  }
  const resolution = normalizeOptionalString(req.resolution);
  if (resolution) {
    imageConfig.image_size = resolution;
  }
  return imageConfig;
}

function shouldUseDedicatedImagesApi(model: string): boolean {
  return DEDICATED_IMAGE_API_MODELS.has(model);
}

function resolveImagesApiModelCapabilities(model: string): OpenRouterImagesApiModelCapabilities {
  return (
    OPENROUTER_IMAGES_API_MODEL_CAPABILITIES[model] ?? {
      maxCount: 1,
      maxInputImages: 0,
    }
  );
}

function assertImagesApiModelCount(
  model: string,
  req: ImageGenerationRequest,
  capabilities: OpenRouterImagesApiModelCapabilities,
): number {
  const count = resolveImageCount(req.count);
  if (
    typeof req.count === "number" &&
    Number.isFinite(req.count) &&
    count > capabilities.maxCount
  ) {
    throw new Error(
      `OpenRouter image model ${model} supports at most ${capabilities.maxCount} output image${
        capabilities.maxCount === 1 ? "" : "s"
      }.`,
    );
  }
  return count;
}

function assertImagesApiModelGeometry(
  model: string,
  req: ImageGenerationRequest,
  capabilities: OpenRouterImagesApiModelCapabilities,
): { aspectRatio?: string; resolution?: string } {
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio && !capabilities.aspectRatios?.includes(aspectRatio)) {
    throw new Error(`OpenRouter image model ${model} does not support aspectRatio=${aspectRatio}.`);
  }
  const resolution = normalizeOptionalString(req.resolution);
  if (resolution && !capabilities.resolutions?.includes(resolution)) {
    if (req.resolutionInferred === true) {
      return { aspectRatio };
    }
    throw new Error(`OpenRouter image model ${model} does not support resolution=${resolution}.`);
  }
  return { aspectRatio, resolution };
}

function assertImagesApiInputImages(
  model: string,
  req: ImageGenerationRequest,
  capabilities: OpenRouterImagesApiModelCapabilities,
) {
  const inputImages = req.inputImages ?? [];
  if (inputImages.length > capabilities.maxInputImages) {
    throw new Error(
      `OpenRouter image model ${model} supports at most ${
        capabilities.maxInputImages
      } reference image${capabilities.maxInputImages === 1 ? "" : "s"}.`,
    );
  }
  return inputImages;
}

function buildImagesApiBody(req: ImageGenerationRequest, model: string) {
  const capabilities = resolveImagesApiModelCapabilities(model);
  const count = assertImagesApiModelCount(model, req, capabilities);
  const { aspectRatio, resolution } = assertImagesApiModelGeometry(model, req, capabilities);
  const inputImages = assertImagesApiInputImages(model, req, capabilities);
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: count,
  };
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  if (resolution) {
    body.resolution = resolution;
  }
  if (inputImages.length > 0) {
    body.input_references = inputImages.map((image) => ({
      type: "image_url",
      image_url: { url: toImageDataUrl(image) },
    }));
  }
  return { body, count };
}

function assertChatCompletionsInputImages(model: string, req: ImageGenerationRequest): void {
  const inputImages = req.inputImages ?? [];
  if (inputImages.length > MAX_CHAT_COMPLETIONS_INPUT_IMAGES) {
    throw new Error(
      `OpenRouter image model ${model} supports at most ${MAX_CHAT_COMPLETIONS_INPUT_IMAGES} reference images.`,
    );
  }
}

export function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [...SUPPORTED_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "openrouter", agentDir }),
    capabilities: {
      generate: {
        maxCount: MAX_IMAGE_RESULTS,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: MAX_IMAGE_RESULTS,
        maxInputImages: MAX_IMAGES_API_INPUT_REFERENCES,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const imageConfig = buildImageConfig(req, model);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          provider: "openrouter",
          capability: "image",
          transport: "http",
        });

      const useImagesApi = shouldUseDedicatedImagesApi(model);
      const imagesApiRequest = useImagesApi ? buildImagesApiBody(req, model) : undefined;
      const count = imagesApiRequest?.count ?? resolveImageCount(req.count);
      if (!useImagesApi) {
        assertChatCompletionsInputImages(model, req);
      }
      const { response, release } = await postJsonRequest({
        url: useImagesApi ? `${baseUrl}/images` : `${baseUrl}/chat/completions`,
        headers,
        body: imagesApiRequest
          ? imagesApiRequest.body
          : {
              model,
              messages: [{ role: "user", content: buildMessageContent(req) }],
              modalities: ["image", "text"],
              n: count,
              ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
            },
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter image generation failed");
        const payload = await readProviderJsonResponse(response, "openrouter.image-generation", {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(
            count,
            resolveGeneratedImageMaxBytes(req),
          ),
        });
        const images = extractOpenRouterImagesFromResponse(payload, {
          malformedResponseError: OPENROUTER_IMAGE_MALFORMED_RESPONSE,
        });
        if (images.length === 0) {
          throw new Error("OpenRouter image generation response missing image data");
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
