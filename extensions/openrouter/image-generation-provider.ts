// Openrouter provider module implements model/runtime integration.
import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import {
  createOpenAiCompatibleImageGenerationProvider,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_RESULTS = 4;
const MAX_INPUT_IMAGES = 5;
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

function isGeminiImageModel(model: string): boolean {
  return model.startsWith("google/gemini-");
}

function buildInputReferences(
  inputImages: ImageGenerationSourceImage[],
): Array<{ type: "image_url"; image_url: { url: string } }> {
  return inputImages.map((image) => ({
    type: "image_url" as const,
    image_url: { url: toImageDataUrl(image) },
  }));
}

function buildRequestBody(params: {
  req: ImageGenerationRequest;
  inputImages: ImageGenerationSourceImage[];
  model: string;
  count: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.req.prompt,
    n: Math.min(params.count, MAX_IMAGE_RESULTS),
  };

  if (isGeminiImageModel(params.model)) {
    const aspectRatio = normalizeOptionalString(params.req.aspectRatio);
    if (aspectRatio) {
      body.aspect_ratio = aspectRatio;
    }
    const resolution = normalizeOptionalString(params.req.resolution);
    if (resolution) {
      body.resolution = resolution;
    }
  }

  if (params.inputImages.length > 0) {
    body.input_references = buildInputReferences(params.inputImages);
  }

  return body;
}

export function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAiCompatibleImageGenerationProvider({
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [...SUPPORTED_MODELS],
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
        maxInputImages: MAX_INPUT_IMAGES,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    defaultBaseUrl: OPENROUTER_BASE_URL,
    resolveBaseUrl: ({ req }) =>
      normalizeOptionalString(req.cfg?.models?.providers?.openrouter?.baseUrl) ??
      OPENROUTER_BASE_URL,
    resolveAllowPrivateNetwork: () => false,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    endpointPath: "images",
    buildGenerateRequest: ({ req, inputImages, model, count }) => ({
      kind: "json",
      body: buildRequestBody({ req, inputImages, model, count }),
    }),
    buildEditRequest: ({ req, inputImages, model, count }) => ({
      kind: "json",
      body: buildRequestBody({ req, inputImages, model, count }),
    }),
    // OpenRouter reports media_type only for non-PNG images, but live testing
    // showed some upstream models return non-PNG bytes without it; fall back
    // to magic-byte sniffing (explicit media_type still wins when present).
    response: { sniffMimeType: true },
    missingApiKeyError: "OpenRouter API key missing",
    failureLabels: {
      generate: "OpenRouter image generation failed",
      edit: "OpenRouter image edit failed",
    },
  });
}
