import { normalizeXaiModelId } from "../model-id.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceXaiToolConfig<TConfig extends Record<string, unknown>>(
  config: Record<string, unknown> | undefined,
): TConfig {
  return isRecord(config) ? (config as TConfig) : ({} as TConfig);
}

export function resolveNormalizedXaiToolModel(params: {
  config?: Record<string, unknown>;
  defaultModel: string;
}): string {
  const value = coerceXaiToolConfig<{ model?: unknown }>(params.config).model;
  return typeof value === "string" && value.trim()
    ? normalizeXaiModelId(value.trim())
    : params.defaultModel;
}

export function resolvePositiveIntegerToolConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const raw = coerceXaiToolConfig<Record<string, unknown>>(config)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const normalized = Math.trunc(raw);
  return normalized > 0 ? normalized : undefined;
}
