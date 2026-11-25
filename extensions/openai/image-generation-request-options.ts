import type {
  ImageGenerationOutputFormat,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import type { resolveClosestSize } from "openclaw/plugin-sdk/media-generation-runtime";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";
import {
  OPENAI_IMAGE_SIZES_BY_MODEL,
  OPENAI_SUPPORTED_SIZES,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
} from "./image-generation-models.js";

export const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";

export function resolveOutputMime(outputFormat?: ImageGenerationOutputFormat): {
  mimeType: string;
  extension: string;
} {
  switch (outputFormat) {
    case "jpeg":
      return { mimeType: "image/jpeg", extension: "jpg" };
    case "webp":
      return { mimeType: "image/webp", extension: "webp" };
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
  return {
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(openai?.moderation !== undefined ? { moderation: openai.moderation } : {}),
    ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
  };
}

export function resolveOpenAIImageRequestModel(
  req: ImageGenerationRequest,
  options?: { allowTransparentDefaultReroute?: boolean },
): string {
  const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
  if (
    options?.allowTransparentDefaultReroute === true &&
    model === DEFAULT_OPENAI_IMAGE_MODEL &&
    (req.providerOptions?.openai?.background ?? req.background) === "transparent"
  ) {
    return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
  }
  return model;
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
