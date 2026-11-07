import type {
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import type { resolveClosestSize } from "openclaw/plugin-sdk/media-generation-runtime";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";

// OpenAI image model catalog and the per-model request rules derived from it.
export const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
export const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const OPENAI_IMAGE_SIZES_BY_MODEL: Record<string, string[]> = {
  "dall-e-2": ["256x256", "512x512", "1024x1024"],
  "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
  [OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL]: OPENAI_LEGACY_IMAGE_SIZES,
  "gpt-image-1": OPENAI_LEGACY_IMAGE_SIZES,
  "gpt-image-1-mini": OPENAI_LEGACY_IMAGE_SIZES,
};
const OPENAI_MAX_INPUT_IMAGES = 5;
export const OPENAI_MAX_IMAGE_RESULTS = 4;
const OPENAI_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const OPENAI_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OPENAI_IMAGE_25_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
const OPENAI_IMAGE_26_MODELS = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] as const;
// Sunburst/Flare share size, quality, and `auto` size rules across 2.5 and 2.6.
const OPENAI_SUNBURST_FLARE_MODELS = [
  ...OPENAI_IMAGE_26_MODELS,
  ...OPENAI_IMAGE_25_MODELS,
] as const;
const OPENAI_SUNBURST_FLARE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const OPENAI_IMAGE_26_OUTPUT_FORMATS = [...OPENAI_OUTPUT_FORMATS, "gif"] as const;
export const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_SUNBURST_FLARE_MODELS,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const OPENAI_FLEXIBLE_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_SUNBURST_FLARE_MODELS,
  "gpt-image-2-2026-04-21",
] as const;

export function resolveOutputMime(outputFormat?: ImageGenerationOutputFormat): {
  mimeType: string;
  extension: string;
} {
  switch (outputFormat) {
    case "jpeg":
      return { mimeType: "image/jpeg", extension: "jpg" };
    case "webp":
      return { mimeType: "image/webp", extension: "webp" };
    case "gif":
      return { mimeType: "image/gif", extension: "gif" };
    default:
      return { mimeType: DEFAULT_OUTPUT_MIME, extension: "png" };
  }
}

export function resolveOpenAIImageOptions(req: ImageGenerationRequest): Record<string, unknown> {
  const openai = req.providerOptions?.openai;
  const background = openai?.background ?? req.background;
  const outputCompression =
    req.outputFormat === "jpeg" || req.outputFormat === "webp"
      ? openai?.outputCompression
      : undefined;
  // OpenAI rejects frame fields on non-GIF requests.
  const gif = req.outputFormat === "gif";
  return {
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(openai?.moderation !== undefined ? { moderation: openai.moderation } : {}),
    ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
    ...(gif && openai?.frameCount !== undefined ? { frame_count: openai.frameCount } : {}),
    ...(gif && openai?.frameDurationMs !== undefined
      ? { frame_duration_ms: openai.frameDurationMs }
      : {}),
  };
}

export function isValidFlexibleOpenAIImageSize(
  model: string,
  size: string | undefined,
  options: { gif: boolean },
): size is string {
  if (!OPENAI_FLEXIBLE_IMAGE_MODELS.some((candidate) => candidate === model)) {
    return false;
  }
  if (size === "auto") {
    return OPENAI_SUNBURST_FLARE_MODELS.some((candidate) => candidate === model);
  }
  const dimensions = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!dimensions) {
    return false;
  }
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const pixels = width * height;
  const multipleOf16 = width > 0 && height > 0 && width % 16 === 0 && height % 16 === 0;
  // GIF size is per frame; OpenAI enforces the frame-count pixel budget itself.
  if (options.gif) {
    return multipleOf16;
  }
  return (
    multipleOf16 &&
    Math.max(width, height) <= 3840 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400 &&
    width <= height * 3 &&
    height <= width * 3
  );
}

export function resolveOpenAIImageRequestSize(
  params: {
    model: string;
    requestedSize?: string;
    applyNativeLimits: boolean;
  },
  resolveSize: typeof resolveClosestSize,
): {
  size: string;
  metadata?: Record<string, string>;
} {
  const requestedSize = params.requestedSize ?? DEFAULT_SIZE;
  if (!params.applyNativeLimits) {
    return { size: requestedSize };
  }
  const supportedSizes = OPENAI_IMAGE_SIZES_BY_MODEL[params.model] ?? OPENAI_SUPPORTED_SIZES;
  const size =
    resolveSize({
      requestedSize,
      supportedSizes,
    }) ?? DEFAULT_SIZE;
  if (size === requestedSize) {
    return { size };
  }
  return {
    size,
    metadata: {
      requestedSize,
      normalizedSize: size,
    },
  };
}

export function buildOpenAIImageCapabilities(): ImageGenerationProvider["capabilities"] {
  return {
    generate: {
      maxCount: 4,
      supportsSize: true,
      supportsAspectRatio: false,
      supportsResolution: false,
    },
    edit: {
      enabled: true,
      maxCount: 4,
      maxInputImages: OPENAI_MAX_INPUT_IMAGES,
      supportsSize: true,
      supportsAspectRatio: false,
      supportsResolution: false,
    },
    geometry: {
      sizes: [...OPENAI_SUPPORTED_SIZES],
      // Empty model-specific lists stop core from snapping valid flexible dimensions.
      sizesByModel: {
        ...OPENAI_IMAGE_SIZES_BY_MODEL,
        ...Object.fromEntries(OPENAI_FLEXIBLE_IMAGE_MODELS.map((model) => [model, []])),
      },
    },
    output: {
      formats: [...OPENAI_OUTPUT_FORMATS],
      qualities: [...OPENAI_QUALITIES],
      formatsByModel: Object.fromEntries(
        OPENAI_IMAGE_26_MODELS.map((model) => [model, [...OPENAI_IMAGE_26_OUTPUT_FORMATS]]),
      ),
      qualitiesByModel: Object.fromEntries(
        OPENAI_SUNBURST_FLARE_MODELS.map((model) => [model, [...OPENAI_SUNBURST_FLARE_QUALITIES]]),
      ),
      backgrounds: [...OPENAI_BACKGROUNDS],
    },
  };
}
