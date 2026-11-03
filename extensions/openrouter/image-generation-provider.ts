import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedImageDownloadMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { postJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenRouterGenerationRequestContext } from "./generation-request-context.js";
import { normalizeOpenRouterBaseUrl } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_RESULTS = 4;
// Chat responses for Gemini image models carry an encrypted reasoning blob next to each image,
// measured at 0.47-0.70x the image's base64 size.
const CHAT_ENCODED_PAYLOADS_PER_IMAGE = 2;
const SUPPORTED_MODELS = [
  DEFAULT_MODEL,
  "google/gemini-3-pro-image-preview",
  "openai/gpt-5.4-image-2",
] as const;
const SUPPORTED_ASPECT_RATIOS = [
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
const OPENROUTER_IMAGE_MALFORMED_RESPONSE = "OpenRouter image generation response malformed";

function throwMalformedOpenRouterImageResponse(): never {
  throw new Error(OPENROUTER_IMAGE_MALFORMED_RESPONSE);
}

function requireOpenRouterImageRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throwMalformedOpenRouterImageResponse();
  }
  return value;
}

function requireOpenRouterImageUrl(value: unknown): string {
  const url = normalizeOptionalString(requireOpenRouterImageRecord(value).url);
  if (!url) {
    throwMalformedOpenRouterImageResponse();
  }
  return url;
}

function pushDataUrlImage(images: GeneratedImageAsset[], dataUrl: string, strict = true): void {
  const image = generatedImageAssetFromDataUrl({ dataUrl, index: images.length });
  if (!image) {
    if (strict) {
      throwMalformedOpenRouterImageResponse();
    }
    return;
  }
  images.push(image);
}

function extractImagesFromPart(images: GeneratedImageAsset[], value: unknown): void {
  const part = requireOpenRouterImageRecord(value);
  if (part.type === "text") {
    return;
  }
  if (part.type === "image_url") {
    pushDataUrlImage(images, requireOpenRouterImageUrl(part.image_url ?? part.imageUrl));
    return;
  }

  let base64 = normalizeOptionalString(part.b64_json);
  let mimeType: string | undefined;
  if (!base64) {
    if ("b64_json" in part) {
      throwMalformedOpenRouterImageResponse();
    }
    const inlineData = part.inlineData ?? part.inline_data;
    if (inlineData === undefined || inlineData === null) {
      return;
    }
    const inline = requireOpenRouterImageRecord(inlineData);
    base64 = normalizeOptionalString(inline.data);
    if (!base64) {
      throwMalformedOpenRouterImageResponse();
    }
    mimeType =
      normalizeOptionalString(inline.mimeType) ??
      normalizeOptionalString(inline.mime_type) ??
      "image/png";
  }
  const image = generatedImageAssetFromBase64({
    base64,
    index: images.length,
    ...(mimeType === undefined ? {} : { mimeType }),
  });
  if (!image) {
    throwMalformedOpenRouterImageResponse();
  }
  images.push(image);
}

function extractOpenRouterImagesFromResponse(body: unknown): GeneratedImageAsset[] {
  const payload = requireOpenRouterImageRecord(body);
  const choices = payload.choices;
  if (choices === undefined || choices === null) {
    return [];
  }
  if (!Array.isArray(choices)) {
    throwMalformedOpenRouterImageResponse();
  }

  const images: GeneratedImageAsset[] = [];
  for (const choiceValue of choices) {
    const choice = requireOpenRouterImageRecord(choiceValue);
    const messageValue = choice.message;
    if (messageValue === undefined || messageValue === null) {
      continue;
    }
    const message = requireOpenRouterImageRecord(messageValue);

    const messageImages = message.images;
    if (messageImages !== undefined && messageImages !== null) {
      if (!Array.isArray(messageImages)) {
        throwMalformedOpenRouterImageResponse();
      }
      for (const entryValue of messageImages) {
        const entry = requireOpenRouterImageRecord(entryValue);
        pushDataUrlImage(images, requireOpenRouterImageUrl(entry.image_url ?? entry.imageUrl));
      }
    }

    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      const dataUrlPattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      for (const match of content.matchAll(dataUrlPattern)) {
        pushDataUrlImage(images, match[0], false);
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        extractImagesFromPart(images, part);
      }
    } else if (content !== undefined && content !== null) {
      throwMalformedOpenRouterImageResponse();
    }
  }
  return images;
}

function normalizeDedicatedImageResponse(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return payload;
  }
  return {
    ...payload,
    data: payload.data.map((entry) => {
      if (!isRecord(entry) || entry.mime_type !== undefined || entry.media_type === undefined) {
        return entry;
      }
      return { ...entry, mime_type: entry.media_type };
    }),
  };
}

function buildImageConfig(req: ImageGenerationRequest, model: string): Record<string, string> {
  if (!model.startsWith("google/gemini-")) {
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

export function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [...SUPPORTED_MODELS],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "openrouter", ...ctx }),
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
        maxInputImages: 5,
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
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveOpenRouterGenerationRequestContext({
          cfg: req.cfg,
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "image",
          // Preserve the existing resolved header contract; postJsonRequest supplies
          // the JSON content type for both chat-completion and dedicated image requests.
          jsonContentType: false,
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const imageConfig = buildImageConfig(req, model);
      const count = resolveIntegerOption(req.count, 1, { min: 1, max: MAX_IMAGE_RESULTS });
      const canonicalBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
      const inputReferences = (req.inputImages ?? []).map((image) => ({
        type: "image_url",
        image_url: { url: toImageDataUrl(image) },
      }));
      const body = canonicalBaseUrl
        ? {
            model,
            prompt: req.prompt,
            n: 1,
            ...(imageConfig.aspect_ratio ? { aspect_ratio: imageConfig.aspect_ratio } : {}),
            ...(imageConfig.image_size ? { resolution: imageConfig.image_size } : {}),
            ...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
          }
        : {
            model,
            messages: [
              {
                role: "user",
                content:
                  inputReferences.length > 0
                    ? [{ type: "text", text: req.prompt }, ...inputReferences]
                    : req.prompt,
              },
            ],
            modalities: ["image", "text"],
            n: count,
            ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
          };
      // Dedicated image requests return one image; legacy chat endpoints accept
      // the whole count. Either route fails the batch if any request fails.
      const generated = await Promise.all(
        Array.from({ length: canonicalBaseUrl ? count : 1 }, async () => {
          const payload = await postJsonResponse<unknown>({
            url: canonicalBaseUrl ? `${canonicalBaseUrl}/images` : `${baseUrl}/chat/completions`,
            headers,
            body,
            timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fetchFn: fetch,
            allowPrivateNetwork,
            ssrfPolicy: req.ssrfPolicy,
            dispatcherPolicy,
            errorLabel: "OpenRouter image generation failed",
            responseLabel: "openrouter.image-generation",
            readOptions: {
              maxBytes: resolveInlineImageJsonResponseMaxBytes(
                canonicalBaseUrl ? 1 : count * CHAT_ENCODED_PAYLOADS_PER_IMAGE,
                resolveGeneratedImageDownloadMaxBytes(req.cfg),
              ),
            },
          });
          const images = canonicalBaseUrl
            ? parseOpenAiCompatibleImageResponse(normalizeDedicatedImageResponse(payload), {
                malformedResponseError: OPENROUTER_IMAGE_MALFORMED_RESPONSE,
                sniffMimeType: true,
              })
            : extractOpenRouterImagesFromResponse(payload);
          if (images.length === 0) {
            throw new Error("OpenRouter image generation response missing image data");
          }
          return images;
        }),
      );
      return { images: generated.flat(), model };
    },
  };
}
