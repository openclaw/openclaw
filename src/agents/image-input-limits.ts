import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_IMAGE_INPUT_PIXELS,
  MAX_CONFIGURED_IMAGE_INPUT_PIXELS,
} from "../media/image-pixel-limits.js";

export const DEFAULT_IMAGE_MAX_INPUT_PIXELS = DEFAULT_IMAGE_INPUT_PIXELS;
export const MAX_IMAGE_MAX_INPUT_PIXELS = MAX_CONFIGURED_IMAGE_INPUT_PIXELS;

/** Resolve the source-image decode limit while retaining the bounded default. */
export function resolveImageInputPixelLimit(cfg?: OpenClawConfig): number {
  const configured = cfg?.agents?.defaults?.imageMaxInputPixels;
  if (
    typeof configured !== "number" ||
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > MAX_IMAGE_MAX_INPUT_PIXELS
  ) {
    return DEFAULT_IMAGE_MAX_INPUT_PIXELS;
  }
  return configured;
}
