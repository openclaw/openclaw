import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";

export const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const OPENAI_IMAGE_25_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
const OPENAI_LEGACY_IMAGE_MODELS = [
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
export const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_IMAGE_25_MODELS,
  ...OPENAI_LEGACY_IMAGE_MODELS,
] as const;
const OPENAI_FLEXIBLE_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_IMAGE_25_MODELS,
  "gpt-image-2-2026-04-21",
] as const;

export function resolveNativeOpenAIImageSizesForModel(model: string): readonly string[] {
  return OPENAI_LEGACY_IMAGE_MODELS.some((candidate) => candidate === model)
    ? OPENAI_LEGACY_IMAGE_SIZES
    : OPENAI_SUPPORTED_SIZES;
}

export function isValidFlexibleOpenAIImageSize(
  model: string,
  size: string | undefined,
): size is string {
  if (!OPENAI_FLEXIBLE_IMAGE_MODELS.some((candidate) => candidate === model)) {
    return false;
  }
  if (size === "auto") {
    return OPENAI_IMAGE_25_MODELS.some((candidate) => candidate === model);
  }
  const dimensions = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!dimensions) {
    return false;
  }
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const pixels = width * height;
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400 &&
    width <= height * 3 &&
    height <= width * 3
  );
}

export function buildOpenAIImageGeometry(): NonNullable<
  ImageGenerationProvider["capabilities"]["geometry"]
> {
  return {
    sizes: [...OPENAI_SUPPORTED_SIZES],
    // Empty model-specific lists stop core from snapping valid flexible dimensions.
    sizesByModel: Object.fromEntries([
      ...OPENAI_FLEXIBLE_IMAGE_MODELS.map((model) => [model, []]),
      ...OPENAI_LEGACY_IMAGE_MODELS.map((model) => [model, [...OPENAI_LEGACY_IMAGE_SIZES]]),
    ]),
  };
}
