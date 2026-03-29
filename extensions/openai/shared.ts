import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

export { cloneFirstTemplateModel, findCatalogTemplate, matchesExactOrPrefix };
