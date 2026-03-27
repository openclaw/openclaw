import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = id.trim().toLowerCase();
  return values.some((value) => {
    const normalizedValue = value.trim().toLowerCase();
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

export { cloneFirstTemplateModel, findCatalogTemplate };
