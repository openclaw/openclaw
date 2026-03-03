export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export function resolveImageSanitizationLimits(cfg) {
    const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
        return {};
    }
    return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
