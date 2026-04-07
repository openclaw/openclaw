import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { applyXaiModelCompat } from "./api.js";
import { resolveXaiCatalogEntry, XAI_BASE_URL } from "./model-definitions.js";

const XAI_MODERN_MODEL_PREFIXES = ["grok-3", "grok-4", "grok-code-fast"] as const;

export function isModernXaiModel(modelId: string): boolean {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  if (!lower || lower.includes("multi-agent")) {
    return false;
  }
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function resolveXaiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
  // eslint-disable-next-line no-redundant-type-constituents -- ProviderRuntimeModel is unresolvable in the extension lint context (treated as `any`), so `| undefined` appears redundant; the union is intentionally correct and required by tsgo for TS2883
}): ProviderRuntimeModel | undefined {
  const definition = resolveXaiCatalogEntry(params.ctx.modelId);
  if (!definition) {
    return undefined;
  }

  return applyXaiModelCompat(
    normalizeModelCompat({
      id: definition.id,
      name: definition.name,
      api: params.ctx.providerConfig?.api ?? "openai-responses",
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
