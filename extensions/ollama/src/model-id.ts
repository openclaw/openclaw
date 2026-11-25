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

export function getOllamaLatestDedupeKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(":latest") ? normalized.slice(0, -":latest".length) : normalized;
}

export function findAvailableOllamaModelName(
  modelName: string,
  availableModelNames: Iterable<string>,
): string | undefined {
  const wantedKey = getOllamaLatestDedupeKey(modelName);
  for (const available of availableModelNames) {
    if (getOllamaLatestDedupeKey(available) === wantedKey) {
      return available;
    }
  }
  return undefined;
}
