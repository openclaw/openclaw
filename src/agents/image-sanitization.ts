import type { OpenClawConfig } from "../config/types.openclaw.js";

// Image sanitization limits shared by tools and provider payload builders.
export type ImageSanitizationLimits = {
  maxDimensionPx?: number;
  maxBytes?: number;
};

export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (configured === undefined) {
    return {};
  }
  return { maxDimensionPx: configured };
}
