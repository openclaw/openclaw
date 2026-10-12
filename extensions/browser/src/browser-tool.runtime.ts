import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export function resolveRuntimeImageSanitization(): { maxDimensionPx: number } | undefined {
  const maxDimensionPx = resolveOptionalIntegerOption(
    getRuntimeConfig().agents?.defaults?.imageMaxDimensionPx,
    { min: 1 },
  );
  if (maxDimensionPx === undefined) {
    return undefined;
  }
  return { maxDimensionPx };
}
