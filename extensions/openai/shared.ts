import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { findCatalogTemplate } from "../../src/plugins/provider-catalog.js";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "../../src/plugins/types.js";

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

export function cloneFirstTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
    const template = params.ctx.modelRegistry.find(
      params.providerId,
      templateId,
    ) as ProviderRuntimeModel | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      ...params.patch,
    } as ProviderRuntimeModel);
  }
  return undefined;
}

export { findCatalogTemplate };
