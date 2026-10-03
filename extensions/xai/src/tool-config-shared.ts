import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeXaiModelId } from "../model-id.js";

export type XaiSearchNetworkPolicy = "strict" | "selfHosted";

export function resolveXaiSearchNetworkPolicy(
  config?: Record<string, unknown>,
): XaiSearchNetworkPolicy {
  if (config?.networkPolicy !== "selfHosted") {
    return "strict";
  }
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim()) {
    throw new Error("xAI Search networkPolicy=selfHosted requires an explicit baseUrl");
  }
  return "selfHosted";
}

export function resolveNormalizedXaiToolModel(params: {
  config?: Record<string, unknown>;
  defaultModel: string;
}): string {
  const value = asNonArrayRecord(params.config).model;
  return typeof value === "string" && value.trim()
    ? normalizeXaiModelId(value.trim())
    : params.defaultModel;
}

export function resolvePositiveIntegerToolConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const raw = asNonArrayRecord(config)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const normalized = Math.trunc(raw);
  return normalized > 0 ? normalized : undefined;
}
