import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export function resolveRuntimeImageSanitization(
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): { maxDimensionPx: number } | undefined {
  const maxDimensionPx = resolveOptionalIntegerOption(
    getConfig().agents?.defaults?.imageMaxDimensionPx,
    { min: 1 },
  );
  if (maxDimensionPx === undefined) {
    return undefined;
  }
  return { maxDimensionPx };
}
