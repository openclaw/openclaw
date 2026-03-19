import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import type { ProviderModelSelectedContext } from "../../src/plugins/types.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  PROVIDER_ID,
  applyFoundryProfileBinding,
  applyFoundryProviderConfig,
  buildFoundryModelCompat,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  normalizeFoundryEndpoint,
  resolveConfiguredModelNameHint,
  resolveFoundryApi,
  resolveFoundryTargetProfileId,
} from "./shared.js";

export function buildMicrosoftFoundryProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Microsoft Foundry",
    docsPath: "/providers/azure",
    envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    auth: [entraIdAuthMethod, apiKeyAuthMethod],
    capabilities: {
      providerFamily: "openai" as const,
    },
    onModelSelected: async (ctx: ProviderModelSelectedContext) => {
      const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
      if (!providerConfig || !ctx.model.startsWith(`${PROVIDER_ID}/`)) {
        return;
      }
      const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
      const existingModel = providerConfig.models.find((model: { id: string }) => model.id === selectedModelId);
      const selectedModelNameHint = resolveConfiguredModelNameHint(selectedModelId, existingModel?.name);
      const selectedModelCompat = buildFoundryModelCompat(selectedModelId, selectedModelNameHint);
      const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
      const nextProviderConfig: ModelProviderConfig = {
        ...providerConfig,
        baseUrl: buildFoundryProviderBaseUrl(providerEndpoint, selectedModelId, selectedModelNameHint),
        api: resolveFoundryApi(selectedModelId, selectedModelNameHint),
        models: [
          {
            ...(existingModel ?? {
              id: selectedModelId,
              name: selectedModelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            }),
            ...(selectedModelCompat ? { compat: selectedModelCompat } : {}),
          },
        ],
      };
      const targetProfileId = resolveFoundryTargetProfileId(ctx.config, ctx.agentDir);
      if (targetProfileId) {
        applyFoundryProfileBinding(ctx.config, targetProfileId);
      }
      applyFoundryProviderConfig(ctx.config, nextProviderConfig);
    },
    normalizeResolvedModel: ({ modelId, model }: ProviderNormalizeResolvedModelContext) => {
      const endpoint = extractFoundryEndpoint(String(model.baseUrl ?? ""));
      if (!endpoint) {
        return model;
      }
      const modelNameHint = resolveConfiguredModelNameHint(modelId, model.name);
      const compat = buildFoundryModelCompat(modelId, modelNameHint);
      return {
        ...model,
        api: resolveFoundryApi(modelId, modelNameHint),
        baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint),
        ...(compat ? { compat } : {}),
      };
    },
    prepareRuntimeAuth: prepareFoundryRuntimeAuth,
  };
}
