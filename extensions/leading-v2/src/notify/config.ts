import type { NotifyConfig } from "./types.js";

const DEFAULTS: NotifyConfig = {
  enabled: true,
  pollIntervalMs: 30_000,
  ttlMs: 7_200_000, // 2h
  maxPerTick: 5,
};

/** Resolve the notify block from plugin config, falling back to defaults (default-on). */
export function resolveNotifyConfig(pluginConfig: Record<string, unknown>): NotifyConfig {
  const block = pluginConfig.notify as Record<string, unknown> | undefined;
  if (!block) {
    return { ...DEFAULTS };
  }
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: block.enabled === undefined ? DEFAULTS.enabled : block.enabled !== false,
    pollIntervalMs: num(block.pollIntervalMs, DEFAULTS.pollIntervalMs),
    ttlMs: num(block.ttlMs, DEFAULTS.ttlMs),
    maxPerTick: num(block.maxPerTick, DEFAULTS.maxPerTick),
  };
}
