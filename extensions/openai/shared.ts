import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";

export function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  return params.templateIds
    .map((templateId) =>
      params.entries.find(
        (entry) =>
          entry.provider.toLowerCase() === params.providerId.toLowerCase() &&
          entry.id.toLowerCase() === templateId.toLowerCase(),
      ),
    )
    .find((entry) => entry !== undefined);
}

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

export { cloneFirstTemplateModel };
