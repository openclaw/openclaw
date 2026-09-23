import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CrabboxWarmImagePolicy = {
  refreshAfterMs: number;
  retainUnusedMs: number;
  keepPrevious: 0 | 1;
};

function duration(value: unknown, key: string, fallback: string, minimumMs: number): number {
  const raw = value === undefined ? fallback : value;
  // Eight digits keep even days within safe integer milliseconds.
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,7}[mhd](?![\s\S])/u.test(raw)) {
    throw new Error(`Crabbox warmImages.${key} must use 1–8 whole digits followed by m, h, or d.`);
  }
  const unitMs = raw.endsWith("d") ? 86_400_000 : raw.endsWith("h") ? 3_600_000 : 60_000;
  const milliseconds = Number(raw.slice(0, -1)) * unitMs;
  if (milliseconds < minimumMs) {
    throw new Error(`Crabbox warmImages.${key} must be at least ${minimumMs / 3_600_000}h.`);
  }
  return milliseconds;
}

export function resolveCrabboxWarmImagePolicy(
  pluginConfig?: Record<string, unknown>,
): CrabboxWarmImagePolicy {
  const raw = pluginConfig?.warmImages;
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("Crabbox warmImages must be an object.");
  }
  const config = raw ?? {};
  const keepPrevious = config.keepPrevious === undefined ? 0 : config.keepPrevious;
  if (keepPrevious !== 0 && keepPrevious !== 1) {
    throw new Error("Crabbox warmImages.keepPrevious must be 0 or 1.");
  }
  return {
    refreshAfterMs: duration(config.refreshAfter, "refreshAfter", "24h", 3_600_000),
    retainUnusedMs: duration(config.retainUnused, "retainUnused", "14d", 86_400_000),
    keepPrevious,
  };
}
