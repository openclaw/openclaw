import type { ProviderNormalizeToolSchemasContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildProviderToolCompatFamilyHooks,
  normalizeKimiToolSchemas,
} from "openclaw/plugin-sdk/provider-tools";
import { normalizeOpenRouterApiModelId, normalizeOpenRouterModelFamilyId } from "./models.js";

const openAiTools = buildProviderToolCompatFamilyHooks("openai");

const moonshotTools = {
  normalizeToolSchemas: normalizeKimiToolSchemas,
  // Retained unions are valid schema contracts, not DeepSeek-incompatible diagnostics.
  inspectToolSchemas: (_ctx: ProviderNormalizeToolSchemasContext) => [],
};

function resolveOpenRouterToolFamily(modelId: string) {
  const normalized =
    normalizeOpenRouterModelFamilyId(normalizeOpenRouterApiModelId(modelId)) ?? modelId;
  if (normalized.startsWith("moonshot/") || normalized.startsWith("moonshotai/")) {
    return moonshotTools;
  }
  return openAiTools;
}

export function normalizeOpenRouterToolSchemas(ctx: ProviderNormalizeToolSchemasContext) {
  return resolveOpenRouterToolFamily(ctx.modelId ?? "").normalizeToolSchemas(ctx);
}

export function inspectOpenRouterToolSchemas(ctx: ProviderNormalizeToolSchemasContext) {
  return resolveOpenRouterToolFamily(ctx.modelId ?? "").inspectToolSchemas(ctx);
}
