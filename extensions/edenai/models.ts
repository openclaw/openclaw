import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export const EDENAI_PROVIDER_ID = "edenai";

export function normalizeEdenaiModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.startsWith("edenai/") ? normalized.slice("edenai/".length) : normalized;
}
