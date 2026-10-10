import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";
import { normalizeUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";

const OLLAMA_PROVIDER_ID = "ollama";

export function normalizeOllamaWireModelId(modelId: string, providerId?: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  for (const candidate of normalizeUniqueTrimmedStringList([
    providerId,
    normalizeProviderId(providerId ?? ""),
    OLLAMA_PROVIDER_ID,
  ])) {
    const prefix = `${candidate}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
