import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Image sanitization limits shared by tools and provider payload builders.
export type ImageSanitizationLimits = {
  maxDimensionPx?: number;
  maxBytes?: number;
};

export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Long side that sanitization enforces for these limits. */
export function resolveImageMaxDimensionPx(limits?: ImageSanitizationLimits): number {
  return resolveIntegerOption(limits?.maxDimensionPx, DEFAULT_IMAGE_MAX_DIMENSION_PX, { min: 1 });
}

export function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (configured === undefined) {
    return {};
  }
  return { maxDimensionPx: configured };
}
