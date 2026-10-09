import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import {
  imageFileExtensionForMimeType,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFalHttpRequestConfig } from "./http-config.js";

const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/dev";
const DEFAULT_FAL_EDIT_SUBPATH = "image-to-image";
const FAL_KREA_2_MODEL_PREFIX = "krea/v2/";
const FAL_KREA_2_MEDIUM_MODEL = "krea/v2/medium/text-to-image";
const FAL_KREA_2_LARGE_MODEL = "krea/v2/large/text-to-image";
const FAL_NANO_BANANA_MODEL = "fal-ai/nano-banana";
const FAL_NANO_BANANA_2_LITE_MODEL = "google/nano-banana-2-lite";
const FAL_GROK_IMAGINE_MODEL = "xai/grok-imagine-image";
const FAL_GPT_IMAGE_25_MODELS = [
  "openai/gpt-image-2.5/flare/text-to-image",
  "openai/gpt-image-2.5/flare/edit",
  "openai/gpt-image-2.5/sunburst/text-to-image",
  "openai/gpt-image-2.5/sunburst/edit",
] as const;
const GPT_IMAGE_25_EDIT_MAX_INPUT_IMAGES = 16;
const GPT_IMAGE_25_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const GPT_IMAGE_25_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const GPT_IMAGE_25_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const DEFAULT_OUTPUT_FORMAT = "png";
const GPT_IMAGE_EDIT_MAX_INPUT_IMAGES = 10;
const NANO_BANANA_LEGACY_EDIT_MAX_INPUT_IMAGES = 3;
const NANO_BANANA_EDIT_MAX_INPUT_IMAGES = 14;
const GROK_IMAGINE_EDIT_MAX_INPUT_IMAGES = 3;
const KREA_STYLE_REFERENCE_MAX_INPUT_IMAGES = 10;
const FAL_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const FAL_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const FAL_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "2.35:1",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;
const KREA_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:2",
  "16:9",
  "2.35:1",
  "4:5",
  "2:3",
  "9:16",
] as const;
const NANO_BANANA_LEGACY_SUPPORTED_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;
const NANO_BANANA_SUPPORTED_ASPECT_RATIOS = [
  ...NANO_BANANA_LEGACY_SUPPORTED_ASPECT_RATIOS,
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;
const GROK_IMAGINE_SUPPORTED_ASPECT_RATIOS = [
  "2:1",
  "20:9",
  "19.5:9",
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "2:3",
  "3:4",
  "9:16",
  "9:19.5",
  "9:20",
  "1:2",
] as const;
const GROK_IMAGINE_SUPPORTED_RESOLUTIONS: readonly ("1K" | "2K" | "4K")[] = ["1K", "2K"] as const;
const KREA_CREATIVITY_LEVELS = ["raw", "low", "medium", "high"] as const;

const FAL_IMAGE_MALFORMED_RESPONSE = "fal image generation response malformed";
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

type FalImageSize = string | { width: number; height: number };
type FalEditEndpointSuffix = "edit" | "image-to-image";
type FalImageModelSchema = {
  geometry: "image_size" | "native_aspect_ratio";
  aspectRatios?: readonly string[];
  resolutions?: readonly ("1K" | "2K" | "4K")[];
  resolutionCase?: "lower";
  referenceImages: "image_url" | "image_urls" | "image_style_references";
  maxInputImages: number;
  referenceLimitLabel: string;
  referenceLimitNoun: "reference image" | "style reference";
  appendEditPath: false | FalEditEndpointSuffix;
  supportsCount: boolean;
  supportsOutputFormat: boolean;
};
function parseFalImageGenerationResponse(payload: unknown) {
  if (!isRecord(payload)) {
    throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
  }
  const images = payload.images ?? [];
  if (!Array.isArray(images) || !images.every(isRecord)) {
    throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
  }
  return { images, prompt: normalizeOptionalString(payload.prompt) };
}

function ensureFalModelPath(
  model: string,
  hasInputImages: boolean,
  schema: FalImageModelSchema,
): string {
  if (!hasInputImages || schema.appendEditPath === false) {
    return model;
  }
  if (isFalGptImage25Model(model)) {
    return model.replace(/\/text-to-image$/, "/edit");
  }
  return model.includes("/image-to-image/") ||
    [schema.appendEditPath, "edit", DEFAULT_FAL_EDIT_SUBPATH].some((suffix) =>
      model.endsWith(`/${suffix}`),
    )
    ? model
    : `${model}/${schema.appendEditPath}`;
}

function isFalGptImage25Model(model: string): boolean {
  return FAL_GPT_IMAGE_25_MODELS.some((candidate) => candidate === model);
}

function resolveFalImageModelSchema(model: string): FalImageModelSchema {
  const editDefaults = {
    referenceImages: "image_urls",
    referenceLimitNoun: "reference image",
    appendEditPath: "edit",
    supportsCount: true,
    supportsOutputFormat: true,
  } as const;
  if (isFalGptImage25Model(model)) {
    return {
      ...editDefaults,
      geometry: "image_size",
      maxInputImages: GPT_IMAGE_25_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal GPT Image 2.5 edit",
    };
  }
  if (model.startsWith(FAL_KREA_2_MODEL_PREFIX)) {
    return {
      geometry: "native_aspect_ratio",
      aspectRatios: KREA_SUPPORTED_ASPECT_RATIOS,
      referenceImages: "image_style_references",
      maxInputImages: KREA_STYLE_REFERENCE_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal Krea 2",
      referenceLimitNoun: "style reference",
      appendEditPath: false,
      supportsCount: false,
      supportsOutputFormat: false,
    };
  }
  if (model === FAL_NANO_BANANA_MODEL || model.startsWith(`${FAL_NANO_BANANA_MODEL}/`)) {
    return {
      ...editDefaults,
      geometry: "native_aspect_ratio",
      aspectRatios: NANO_BANANA_LEGACY_SUPPORTED_ASPECT_RATIOS,
      resolutions: [],
      maxInputImages: NANO_BANANA_LEGACY_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal Nano Banana",
    };
  }
  if (model.startsWith("openai/gpt-image-") || model.startsWith(`${FAL_NANO_BANANA_MODEL}-`)) {
    const isNanoBanana = model.startsWith(`${FAL_NANO_BANANA_MODEL}-`);
    return {
      ...editDefaults,
      geometry: isNanoBanana ? "native_aspect_ratio" : "image_size",
      ...(isNanoBanana ? { aspectRatios: NANO_BANANA_SUPPORTED_ASPECT_RATIOS } : {}),
      maxInputImages: isNanoBanana
        ? NANO_BANANA_EDIT_MAX_INPUT_IMAGES
        : GPT_IMAGE_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: isNanoBanana ? "fal Nano Banana 2" : "fal GPT Image edit",
    };
  }
  // Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image) uses /edit and the same
  // aspect_ratio/image_urls contracts as Nano Banana 2. Its published schema
  // has no resolution field, so explicit resolution overrides fail locally.
  if (model.startsWith(FAL_NANO_BANANA_2_LITE_MODEL)) {
    return {
      ...editDefaults,
      geometry: "native_aspect_ratio",
      aspectRatios: NANO_BANANA_SUPPORTED_ASPECT_RATIOS,
      resolutions: [],
      maxInputImages: NANO_BANANA_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal Nano Banana 2 Lite",
    };
  }
  // Grok Imagine (xAI) — text-to-image at /xai/grok-imagine-image, standard
  // edits at /xai/grok-imagine-image/edit. Explicit quality/edit model paths
  // remain unchanged. Accepts up to 3 reference images via image_urls.
  if (model.startsWith(FAL_GROK_IMAGINE_MODEL)) {
    return {
      ...editDefaults,
      geometry: "native_aspect_ratio",
      aspectRatios: GROK_IMAGINE_SUPPORTED_ASPECT_RATIOS,
      resolutions: GROK_IMAGINE_SUPPORTED_RESOLUTIONS,
      resolutionCase: "lower",
      maxInputImages: GROK_IMAGINE_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal Grok Imagine",
    };
  }
  return {
    geometry: "image_size",
    referenceImages: "image_url",
    maxInputImages: 1,
    referenceLimitLabel: "fal flux image generation currently",
    referenceLimitNoun: "reference image",
    appendEditPath: "image-to-image",
    supportsCount: true,
    supportsOutputFormat: true,
  };
}

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

const FAL_ASPECT_RATIO_SIZES = new Map([
  ["1:1", "square_hd"],
  ["4:3", "landscape_4_3"],
  ["3:4", "portrait_4_3"],
  ["16:9", "landscape_16_9"],
  ["9:16", "portrait_16_9"],
]);

function parseAspectRatioParts(aspectRatio: string): { widthRatio: number; heightRatio: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(aspectRatio.trim());
  if (!match) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
  const widthRatio = Number.parseFloat(match[1] ?? "");
  const heightRatio = Number.parseFloat(match[2] ?? "");
  if (
    !Number.isFinite(widthRatio) ||
    !Number.isFinite(heightRatio) ||
    widthRatio <= 0 ||
    heightRatio <= 0
  ) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
  return { widthRatio, heightRatio };
}

function aspectRatioToDimensions(
  aspectRatio: string,
  edge: number,
): { width: number; height: number } {
  const { widthRatio, heightRatio } = parseAspectRatioParts(aspectRatio);
  if (widthRatio >= heightRatio) {
    return {
      width: edge,
      height: Math.max(1, Math.round((edge * heightRatio) / widthRatio)),
    };
  }
  return {
    width: Math.max(1, Math.round((edge * widthRatio) / heightRatio)),
    height: edge,
  };
}

function resolveFalImageSize(
  req: ImageGenerationRequest,
  hasInputImages: boolean,
): FalImageSize | undefined {
  const parsed = parseSize(req.size);
  if (parsed) {
    return parsed;
  }

  const normalizedAspectRatio = req.aspectRatio?.trim();
  const edge = req.resolution
    ? req.resolution === "4K"
      ? 4096
      : req.resolution === "2K"
        ? 2048
        : 1024
    : undefined;
  if (normalizedAspectRatio) {
    if (edge && !hasInputImages) {
      return aspectRatioToDimensions(normalizedAspectRatio, edge);
    }
    return (
      FAL_ASPECT_RATIO_SIZES.get(normalizedAspectRatio) ??
      aspectRatioToDimensions(normalizedAspectRatio, 1024)
    );
  }
  return edge ? { width: edge, height: edge } : undefined;
}

function validateFalGptImage25Size(size: FalImageSize | undefined): void {
  if (size === undefined || typeof size === "string") {
    return;
  }
  const { width, height } = size;
  const pixels = width * height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    Math.max(width, height) > 3840 ||
    pixels < 655_360 ||
    pixels > 8_294_400 ||
    width > height * 3 ||
    height > width * 3
  ) {
    throw new Error(
      "fal GPT Image 2.5 requires size dimensions divisible by 16, edges up to 3840, " +
        "655360-8294400 pixels, and aspect ratio between 1:3 and 3:1. " +
        "Use size 1024x1024, 1536x1024, 1024x1536, or auto instead of incompatible geometry hints.",
    );
  }
}

function aspectRatioScore(aspectRatio: string, targetRatio: number): number {
  const { widthRatio, heightRatio } = parseAspectRatioParts(aspectRatio);
  return Math.abs(Math.log(widthRatio / heightRatio) - Math.log(targetRatio));
}

function resolveClosestFalAspectRatioForSize(
  imageSize: FalImageSize | undefined,
  aspectRatios: readonly string[],
): string | undefined {
  if (!imageSize || typeof imageSize === "string") {
    return undefined;
  }
  const targetRatio = imageSize.width / imageSize.height;
  return aspectRatios.reduce<string | undefined>((best, candidate) => {
    if (!best) {
      return candidate;
    }
    return aspectRatioScore(candidate, targetRatio) < aspectRatioScore(best, targetRatio)
      ? candidate
      : best;
  }, undefined);
}

function resolveFalCreativityOption(providerOptions: Record<string, unknown> | undefined): string {
  const falOptions = isRecord(providerOptions?.fal) ? providerOptions.fal : undefined;
  const normalized = normalizeLowercaseStringOrEmpty(falOptions?.creativity);
  return KREA_CREATIVITY_LEVELS.some((level) => level === normalized) ? normalized : "medium";
}

function resolveNativeFalAspectRatio(
  schema: FalImageModelSchema,
  aspectRatio?: string,
  imageSize?: FalImageSize,
): string | undefined {
  const requestedAspectRatio = aspectRatio?.trim();
  const allowedAspectRatios = schema.aspectRatios;
  if (requestedAspectRatio) {
    if (allowedAspectRatios && !allowedAspectRatios.includes(requestedAspectRatio)) {
      throw new Error(
        `${schema.referenceLimitLabel} supports aspectRatio values: ${allowedAspectRatios.join(", ")}`,
      );
    }
    return requestedAspectRatio;
  }
  if (allowedAspectRatios) {
    return resolveClosestFalAspectRatioForSize(imageSize, allowedAspectRatios);
  }
  return undefined;
}

function applyFalImageGeometry(
  requestBody: Record<string, unknown>,
  schema: FalImageModelSchema,
  req: ImageGenerationRequest,
  imageSize?: FalImageSize,
) {
  if (schema.geometry === "native_aspect_ratio") {
    if (req.resolution && schema.referenceImages === "image_style_references") {
      throw new Error("fal Krea 2 supports aspectRatio but not resolution overrides");
    }
    const nativeAspectRatio = resolveNativeFalAspectRatio(
      schema,
      req.aspectRatio,
      req.size ? imageSize : undefined,
    );
    if (nativeAspectRatio) {
      requestBody.aspect_ratio = nativeAspectRatio;
    }
    if (req.resolution && schema.referenceImages === "image_urls") {
      // An absent allowlist forwards resolutions; an empty one rejects all overrides.
      const allowedResolutions = schema.resolutions;
      if (allowedResolutions === undefined) {
        requestBody.resolution = req.resolution;
      } else if (allowedResolutions.length === 0) {
        throw new Error(`${schema.referenceLimitLabel} does not support resolution overrides`);
      } else if (!allowedResolutions.includes(req.resolution)) {
        throw new Error(
          `${schema.referenceLimitLabel} supports resolution values: ${allowedResolutions.join(", ")}`,
        );
      } else {
        requestBody.resolution =
          schema.resolutionCase === "lower" ? req.resolution.toLowerCase() : req.resolution;
      }
    }
    return;
  }
  if (imageSize !== undefined) {
    requestBody.image_size = imageSize;
  }
}

function applyFalReferenceImages(
  requestBody: Record<string, unknown>,
  schema: FalImageModelSchema,
  inputImages: ImageGenerationSourceImage[],
) {
  const encoded = inputImages.map(toImageDataUrl);
  if (schema.referenceImages === "image_urls") {
    requestBody.image_urls = encoded;
    return;
  }
  if (schema.referenceImages === "image_style_references") {
    requestBody.image_style_references = encoded.map((imageUrl) => ({
      image_url: imageUrl,
    }));
    return;
  }
  const [input] = encoded;
  if (!input) {
    throw new Error("fal image edit request missing reference image");
  }
  requestBody.image_url = input;
}

function formatFalReferenceLimitError(
  schema: FalImageModelSchema,
  inputImageCount: number,
): string {
  const limit = schema.maxInputImages === 1 ? "one" : String(schema.maxInputImages);
  const noun =
    schema.maxInputImages === 1 ? schema.referenceLimitNoun : `${schema.referenceLimitNoun}s`;
  return `${schema.referenceLimitLabel} supports at most ${limit} ${noun} (requested ${inputImageCount})`;
}

async function fetchImageBuffer(
  url: string,
  deadline: ProviderOperationDeadline,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs: resolveProviderOperationTimeoutMs({
      deadline,
      defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    }),
    auditContext: "fal-image-download",
  });
  try {
    await assertOkOrThrowProviderError(response, "fal image download failed");
    const mimeType = response.headers.get("content-type")?.trim() || "image/png";
    return {
      buffer: await readResponseWithLimit(response, maxBytes, {
        onOverflow: ({ maxBytes: maxBytesLocal }) =>
          new Error(`fal generated image download exceeds ${maxBytesLocal} bytes`),
      }),
      mimeType,
    };
  } finally {
    await release();
  }
}

export function buildFalImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_IMAGE_MODEL,
    models: [
      DEFAULT_FAL_IMAGE_MODEL,
      `${DEFAULT_FAL_IMAGE_MODEL}/${DEFAULT_FAL_EDIT_SUBPATH}`,
      FAL_KREA_2_MEDIUM_MODEL,
      FAL_KREA_2_LARGE_MODEL,
      ...FAL_GPT_IMAGE_25_MODELS,
    ],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "fal", ...ctx }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 1,
        maxInputImagesByModel: {
          ...Object.fromEntries(
            FAL_GPT_IMAGE_25_MODELS.map((model) => [model, GPT_IMAGE_25_EDIT_MAX_INPUT_IMAGES]),
          ),
          [FAL_NANO_BANANA_MODEL]: NANO_BANANA_LEGACY_EDIT_MAX_INPUT_IMAGES,
          [`${FAL_NANO_BANANA_MODEL}/edit`]: NANO_BANANA_LEGACY_EDIT_MAX_INPUT_IMAGES,
        },
        maxInputImagesByModelPrefix: {
          "openai/gpt-image-": GPT_IMAGE_EDIT_MAX_INPUT_IMAGES,
          [FAL_KREA_2_MODEL_PREFIX]: KREA_STYLE_REFERENCE_MAX_INPUT_IMAGES,
          [`${FAL_NANO_BANANA_MODEL}-`]: NANO_BANANA_EDIT_MAX_INPUT_IMAGES,
          [FAL_NANO_BANANA_2_LITE_MODEL]: NANO_BANANA_EDIT_MAX_INPUT_IMAGES,
          [FAL_GROK_IMAGINE_MODEL]: GROK_IMAGINE_EDIT_MAX_INPUT_IMAGES,
        },
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...FAL_SUPPORTED_SIZES],
        sizesByModel: {
          ...Object.fromEntries(FAL_GPT_IMAGE_25_MODELS.map((model) => [model, []])),
          [FAL_KREA_2_MEDIUM_MODEL]: [],
          [FAL_KREA_2_LARGE_MODEL]: [],
        },
        aspectRatios: [...FAL_SUPPORTED_ASPECT_RATIOS],
        aspectRatiosByModel: Object.fromEntries(
          [
            FAL_NANO_BANANA_MODEL,
            `${FAL_NANO_BANANA_MODEL}/edit`,
            FAL_NANO_BANANA_2_LITE_MODEL,
            `${FAL_NANO_BANANA_2_LITE_MODEL}/edit`,
            FAL_GROK_IMAGINE_MODEL,
            `${FAL_GROK_IMAGINE_MODEL}/edit`,
            `${FAL_GROK_IMAGINE_MODEL}/quality`,
            `${FAL_GROK_IMAGINE_MODEL}/quality/edit`,
            FAL_KREA_2_MEDIUM_MODEL,
            FAL_KREA_2_LARGE_MODEL,
            `${FAL_NANO_BANANA_MODEL}-2`,
            `${FAL_NANO_BANANA_MODEL}-2/edit`,
          ].flatMap((model) => {
            const aspectRatios = resolveFalImageModelSchema(model).aspectRatios;
            return aspectRatios ? [[model, [...aspectRatios]] as const] : [];
          }),
        ),
        resolutions: ["1K", "2K", "4K"],
        resolutionsByModel: {
          ...Object.fromEntries(FAL_GPT_IMAGE_25_MODELS.map((model) => [model, []])),
          [FAL_KREA_2_MEDIUM_MODEL]: [],
          [FAL_KREA_2_LARGE_MODEL]: [],
          [FAL_NANO_BANANA_MODEL]: [],
          [`${FAL_NANO_BANANA_MODEL}/edit`]: [],
          [FAL_NANO_BANANA_2_LITE_MODEL]: [],
          [`${FAL_NANO_BANANA_2_LITE_MODEL}/edit`]: [],
          [FAL_GROK_IMAGINE_MODEL]: [...GROK_IMAGINE_SUPPORTED_RESOLUTIONS],
          [`${FAL_GROK_IMAGINE_MODEL}/edit`]: [...GROK_IMAGINE_SUPPORTED_RESOLUTIONS],
          [`${FAL_GROK_IMAGINE_MODEL}/quality`]: [...GROK_IMAGINE_SUPPORTED_RESOLUTIONS],
          [`${FAL_GROK_IMAGINE_MODEL}/quality/edit`]: [...GROK_IMAGINE_SUPPORTED_RESOLUTIONS],
        },
      },
      output: {
        formats: [...FAL_OUTPUT_FORMATS],
        formatsByModel: Object.fromEntries(
          FAL_GPT_IMAGE_25_MODELS.map((model) => [model, [...GPT_IMAGE_25_OUTPUT_FORMATS]]),
        ),
        qualitiesByModel: Object.fromEntries(
          FAL_GPT_IMAGE_25_MODELS.map((model) => [model, [...GPT_IMAGE_25_QUALITIES]]),
        ),
        backgroundsByModel: Object.fromEntries(
          FAL_GPT_IMAGE_25_MODELS.map((model) => [model, [...GPT_IMAGE_25_BACKGROUNDS]]),
        ),
      },
    },
    async generateImage(req) {
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "fal image generation",
      });
      const inputImageCount = req.inputImages?.length ?? 0;
      const hasInputImages = inputImageCount > 0;
      const requestedModel = req.model?.trim() || DEFAULT_FAL_IMAGE_MODEL;
      const schema = resolveFalImageModelSchema(requestedModel);
      const isGptImage25 = isFalGptImage25Model(requestedModel);
      if (isGptImage25 && req.resolution) {
        throw new Error(
          "fal GPT Image 2.5 does not support resolution overrides; use size instead",
        );
      }
      if (isGptImage25 && req.size && req.size !== "auto" && !parseSize(req.size)) {
        throw new Error("fal GPT Image 2.5 size must be WIDTHxHEIGHT or auto");
      }
      let imageSize: FalImageSize | undefined;
      if (isGptImage25 && req.size === "auto") {
        imageSize = "auto";
      } else if (isGptImage25 && req.aspectRatio && !req.size) {
        // Keep ratios through 3:1 above the pixel minimum and on the API's 16px grid.
        const { width, height } = aspectRatioToDimensions(req.aspectRatio, 1536);
        imageSize = { width: Math.round(width / 16) * 16, height: Math.round(height / 16) * 16 };
      } else {
        imageSize = resolveFalImageSize(req, hasInputImages);
      }
      if (isGptImage25) {
        validateFalGptImage25Size(imageSize);
      }
      const model = ensureFalModelPath(requestedModel, hasInputImages, schema);

      if (hasInputImages && inputImageCount > schema.maxInputImages) {
        throw new Error(formatFalReferenceLimitError(schema, inputImageCount));
      }

      // Flux/custom edit endpoints use the singular image_url contract.
      if (hasInputImages && schema.referenceImages === "image_url" && req.aspectRatio) {
        throw new Error("fal flux image edit endpoint does not support aspectRatio overrides");
      }
      if (!schema.supportsCount && (req.count ?? 1) > 1) {
        throw new Error(`fal ${requestedModel} supports one output image per request`);
      }
      if (!schema.supportsOutputFormat && req.outputFormat) {
        throw new Error(`fal ${requestedModel} does not support outputFormat overrides`);
      }
      const { baseUrl, headers, dispatcherPolicy } = await resolveFalHttpRequestConfig({
        req,
        capability: "image",
      });
      const maxImageBytes = resolveGeneratedMediaMaxBytes(req.cfg, "image");
      const requestBody: Record<string, unknown> = {
        prompt: req.prompt,
        ...(schema.supportsCount ? { num_images: req.count ?? 1 } : {}),
        ...(schema.supportsOutputFormat
          ? { output_format: req.outputFormat ?? DEFAULT_OUTPUT_FORMAT }
          : {}),
        ...(isGptImage25 && req.quality ? { quality: req.quality } : {}),
        ...(isGptImage25 && req.background ? { background: req.background } : {}),
      };
      if (schema.referenceImages === "image_style_references") {
        requestBody.creativity = resolveFalCreativityOption(req.providerOptions);
      }
      applyFalImageGeometry(requestBody, schema, req, imageSize);

      if (hasInputImages) {
        applyFalReferenceImages(requestBody, schema, req.inputImages ?? []);
      }
      const { response, release } = await fetchWithSsrFGuard({
        url: `${baseUrl}/${model}`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        timeoutMs:
          deadline.timeoutMs === undefined
            ? undefined
            : resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: deadline.timeoutMs,
              }),
        dispatcherPolicy,
        auditContext: "fal-image-generate",
      });
      try {
        await assertOkOrThrowHttpError(response, "fal image generation failed");

        const payload = parseFalImageGenerationResponse(
          await readProviderJsonResponse(response, "fal.image-generation"),
        );
        const images: GeneratedImageAsset[] = [];
        let imageIndex = 0;
        for (const entry of payload.images) {
          const url = normalizeOptionalString(entry.url);
          if (!url) {
            throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
          }
          const downloaded = await fetchImageBuffer(url, deadline, maxImageBytes);
          imageIndex += 1;
          images.push({
            buffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            fileName: `image-${imageIndex}.${imageFileExtensionForMimeType(downloaded.mimeType)}`,
          });
        }

        if (images.length === 0) {
          throw new Error("fal image generation response missing image data");
        }

        return {
          images,
          model,
          metadata: payload.prompt ? { prompt: payload.prompt } : undefined,
        };
      } finally {
        await release();
      }
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
