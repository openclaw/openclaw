import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";

// OpenAI image model catalog and per-model request limits advertised to image generation.
export const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
export const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
export const OPENAI_IMAGE_SIZES_BY_MODEL: Record<string, string[]> = {
  "dall-e-2": ["256x256", "512x512", "1024x1024"],
  "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
  [OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL]: OPENAI_LEGACY_IMAGE_SIZES,
  "gpt-image-1": OPENAI_LEGACY_IMAGE_SIZES,
  "gpt-image-1-mini": OPENAI_LEGACY_IMAGE_SIZES,
};
const OPENAI_MAX_INPUT_IMAGES = 5;
const OPENAI_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const OPENAI_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;
// GPT Image 2.5 and 2.6 share auto and flexible WIDTHxHEIGHT sizes, xhigh/max quality, and native
// transparent backgrounds. OpenAI's size and quality prose still names only 2.5; 2.6 parity comes
// from the Images API model enum plus a 2026-11-07 live validation probe of both 2.6 models.
const OPENAI_SUNBURST_FLARE_IMAGE_MODELS = [
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;
const OPENAI_SUNBURST_FLARE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_SUNBURST_FLARE_IMAGE_MODELS,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const OPENAI_FLEXIBLE_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_SUNBURST_FLARE_IMAGE_MODELS,
  "gpt-image-2-2026-04-21",
] as const;

export function isValidFlexibleOpenAIImageSize(
  model: string,
  size: string | undefined,
): size is string {
  if (!OPENAI_FLEXIBLE_IMAGE_MODELS.some((candidate) => candidate === model)) {
    return false;
  }
  if (size === "auto") {
    return OPENAI_SUNBURST_FLARE_IMAGE_MODELS.some((candidate) => candidate === model);
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
      qualitiesByModel: Object.fromEntries(
        OPENAI_SUNBURST_FLARE_IMAGE_MODELS.map((model) => [
          model,
          [...OPENAI_SUNBURST_FLARE_QUALITIES],
        ]),
      ),
      backgrounds: [...OPENAI_BACKGROUNDS],
    },
  };
}
