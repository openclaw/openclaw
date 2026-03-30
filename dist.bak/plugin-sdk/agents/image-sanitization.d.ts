import type { OpenClawConfig } from "../config/config.js";
export type ImageSanitizationLimits = {
    maxDimensionPx?: number;
    maxBytes?: number;
};
export declare const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
export declare const DEFAULT_IMAGE_MAX_BYTES: number;
export declare function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits;
