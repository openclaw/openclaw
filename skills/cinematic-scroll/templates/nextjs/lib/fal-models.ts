/**
 * fal.ai model registry — per-model input adapters.
 *
 * Each model on fal.ai has subtly different input parameters:
 *   - FLUX.2 family uses `image_size` (enum) and ignores `negative_prompt`/`num_images`
 *   - Gemini "Nano Banana" family uses `aspect_ratio` (different enum) + `resolution` + `num_images`
 *   - Imagen 3 uses `aspect_ratio`
 *
 * This file is the single source of truth that maps a generic `GenericImageRequest`
 * to the exact shape each model expects. Update here when fal.ai changes a schema —
 * never inline model params in calling code.
 *
 * Source: https://fal.ai/docs/model-api-reference (verified 2026).
 */

export type FalImageModelId =
  | 'fal-ai/flux-2-pro'
  | 'fal-ai/flux-2-max'
  | 'fal-ai/flux-2/turbo'
  | 'fal-ai/flux-pro/v1.1/ultra'
  | 'fal-ai/flux-pro/v1.1'
  | 'fal-ai/gemini-3-pro-image-preview'
  | 'fal-ai/gemini-3.1-flash-image-preview'
  | 'fal-ai/gemini-2.5-flash-image'
  | 'fal-ai/imagen3';

export type Orientation = 'landscape' | 'portrait' | 'square';
export type OutputFormat = 'jpeg' | 'png' | 'webp';

export type GenericImageRequest = {
  prompt: string;
  /** What the asset is for — drives orientation defaults. */
  orientation: Orientation;
  /** Inline negative-prompt language. FLUX ignores `negative_prompt` so we append it to the prompt string instead. */
  avoid?: string;
  outputFormat?: OutputFormat;
  seed?: number;
  /** Gemini-only: 1K | 2K | 4K. Ignored by FLUX models. */
  resolution?: '1K' | '2K' | '4K';
};

export type FalModelDescriptor = {
  id: FalImageModelId;
  family: 'flux' | 'gemini' | 'imagen';
  /** Approx cost in USD per generation. */
  costPerImage: number;
  /** Typical wall-clock seconds. */
  speedSec: number;
  buildInput: (req: GenericImageRequest) => Record<string, unknown>;
  /** Extract the first image URL from a fal result. */
  extractUrl: (data: unknown) => string | undefined;
};

// ─── FLUX family ──────────────────────────────────────────────────────────

const FLUX_IMAGE_SIZE: Record<Orientation, string> = {
  landscape: 'landscape_16_9',
  portrait: 'portrait_4_3',
  square: 'square_hd',
};

const buildFluxInput = (req: GenericImageRequest) => {
  // FLUX.2 ignores negative_prompt — inline it into the prompt instead.
  const prompt = req.avoid ? `${req.prompt} Avoid: ${req.avoid}.` : req.prompt;
  return {
    prompt,
    image_size: FLUX_IMAGE_SIZE[req.orientation],
    output_format: req.outputFormat === 'webp' ? 'png' : (req.outputFormat ?? 'jpeg'),
    enable_safety_checker: true,
    safety_tolerance: '2',
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  };
};

// ─── Gemini family (Nano Banana) ──────────────────────────────────────────

const GEMINI_ASPECT: Record<Orientation, string> = {
  landscape: '16:9',
  portrait: '3:4',
  square: '1:1',
};

const buildGeminiInput = (req: GenericImageRequest) => {
  // Gemini supports negative-language via prompt rewriting only.
  const prompt = req.avoid ? `${req.prompt} Avoid: ${req.avoid}.` : req.prompt;
  return {
    prompt,
    aspect_ratio: GEMINI_ASPECT[req.orientation],
    output_format: req.outputFormat ?? 'png',
    resolution: req.resolution ?? '1K',
    num_images: 1,
    safety_tolerance: '4',
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  };
};

// ─── Imagen 3 ─────────────────────────────────────────────────────────────

const IMAGEN_ASPECT: Record<Orientation, string> = {
  landscape: '16:9',
  portrait: '3:4',
  square: '1:1',
};

const buildImagenInput = (req: GenericImageRequest) => ({
  prompt: req.avoid ? `${req.prompt} Avoid: ${req.avoid}.` : req.prompt,
  aspect_ratio: IMAGEN_ASPECT[req.orientation],
  num_images: 1,
  ...(req.seed !== undefined ? { seed: req.seed } : {}),
});

// ─── Shared output extractor ──────────────────────────────────────────────

const extractFirstUrl = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const images = (data as { images?: Array<{ url?: string }> }).images;
  return images?.[0]?.url;
};

// ─── Registry ─────────────────────────────────────────────────────────────

export const FAL_MODELS: Record<FalImageModelId, FalModelDescriptor> = {
  'fal-ai/flux-2-pro': {
    id: 'fal-ai/flux-2-pro',
    family: 'flux',
    costPerImage: 0.06,
    speedSec: 4,
    buildInput: buildFluxInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/flux-2-max': {
    id: 'fal-ai/flux-2-max',
    family: 'flux',
    costPerImage: 0.08,
    speedSec: 5,
    buildInput: buildFluxInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/flux-2/turbo': {
    id: 'fal-ai/flux-2/turbo',
    family: 'flux',
    costPerImage: 0.02,
    speedSec: 2,
    buildInput: buildFluxInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/flux-pro/v1.1/ultra': {
    id: 'fal-ai/flux-pro/v1.1/ultra',
    family: 'flux',
    costPerImage: 0.06,
    speedSec: 10,
    buildInput: buildFluxInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/flux-pro/v1.1': {
    id: 'fal-ai/flux-pro/v1.1',
    family: 'flux',
    costPerImage: 0.05,
    speedSec: 4.5,
    buildInput: buildFluxInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/gemini-3-pro-image-preview': {
    id: 'fal-ai/gemini-3-pro-image-preview',
    family: 'gemini',
    costPerImage: 0.15,
    speedSec: 8,
    buildInput: buildGeminiInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/gemini-3.1-flash-image-preview': {
    id: 'fal-ai/gemini-3.1-flash-image-preview',
    family: 'gemini',
    costPerImage: 0.07,
    speedSec: 2,
    buildInput: buildGeminiInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/gemini-2.5-flash-image': {
    id: 'fal-ai/gemini-2.5-flash-image',
    family: 'gemini',
    costPerImage: 0.04,
    speedSec: 2,
    buildInput: buildGeminiInput,
    extractUrl: extractFirstUrl,
  },
  'fal-ai/imagen3': {
    id: 'fal-ai/imagen3',
    family: 'imagen',
    costPerImage: 0.04,
    speedSec: 3,
    buildInput: buildImagenInput,
    extractUrl: extractFirstUrl,
  },
};

/** Resolve a model id from env or fallback to FLUX.2 Pro (the recommended default). */
export function resolveModelId(envValue?: string): FalImageModelId {
  const id = envValue as FalImageModelId | undefined;
  return id && id in FAL_MODELS ? id : 'fal-ai/flux-2-pro';
}

export function getModel(id: FalImageModelId): FalModelDescriptor {
  return FAL_MODELS[id];
}

export const ALLOWED_FAL_ENDPOINTS = [
  ...Object.keys(FAL_MODELS),
  // Edit variants — many models also expose /edit
  'fal-ai/flux-2-pro/edit',
  'fal-ai/gemini-3-pro-image-preview/edit',
  'fal-ai/gemini-3.1-flash-image-preview/edit',
];
