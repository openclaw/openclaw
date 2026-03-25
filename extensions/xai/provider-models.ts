import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { applyXaiModelCompat, normalizeModelCompat } from "openclaw/plugin-sdk/provider-models";
import { resolveXaiCatalogEntry, XAI_BASE_URL } from "./model-definitions.js";

const XAI_MODERN_MODEL_PREFIXES = ["grok-3", "grok-4", "grok-code-fast"] as const;

export function isModernXaiModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  if (!lower || lower.includes("multi-agent")) {
    return false;
  }
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const definition = resolveXaiCatalogEntry(params.ctx.modelId);
  if (!definition) {
    return undefined;
  }

  return applyXaiModelCompat(
    normalizeModelCompat({
      id: definition.id,
      name: definition.name,
      api: params.ctx.providerConfig?.api ?? "openai-completions",
      provider: params.providerId,
      baseUrl: params.ctx.providerConfig?.baseUrl ?? XAI_BASE_URL,
      reasoning: definition.reasoning,
      input: definition.input,
      cost: definition.cost,
      contextWindow: definition.contextWindow,
      maxTokens: definition.maxTokens,
    } as ProviderRuntimeModel),
  );
}
