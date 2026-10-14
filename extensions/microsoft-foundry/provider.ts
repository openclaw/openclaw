import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import { applyAuthProfileConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  resolveClaudeThinkingProfile,
  supportsClaudeNativeMaxEffort,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  PROVIDER_ID,
  buildFoundryModelConfig,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  isFoundryProviderApi,
  normalizeFoundryEndpoint,
  resolveFoundryModelCapabilities,
  resolveFoundryTargetProfileId,
} from "./shared.js";

const { wrapStreamFn: wrapOpenAIResponsesStreamFn } = buildProviderStreamFamilyHooks(
  "openai-responses-defaults",
);

const wrapMicrosoftFoundryStreamFn: NonNullable<ProviderPlugin["wrapStreamFn"]> = (ctx) => {
  if (ctx.model?.api !== "openai-responses") {
    return ctx.streamFn ?? null;
  }

  const baseStreamFn = ctx.streamFn;
  if (!baseStreamFn) {
    return wrapOpenAIResponsesStreamFn?.(ctx) ?? null;
  }

  const streamFnWithResponsesReplayIds: NonNullable<typeof ctx.streamFn> = (
    model,
    context,
    options,
  ) =>
    baseStreamFn(model, context, {
      ...options,
      // Foundry validates encrypted reasoning replay against the original item id,
      // even though its Responses endpoint does not support persisted `store`.
      replayResponsesItemIds: true,
    } as typeof options & { replayResponsesItemIds: true });

  return (
    wrapOpenAIResponsesStreamFn?.({
      ...ctx,
      streamFn: streamFnWithResponsesReplayIds,
    }) ?? streamFnWithResponsesReplayIds
  );
};

function normalizeFoundryModel<
  T extends Pick<ModelDefinitionConfig, "reasoning" | "thinkingLevelMap" | "params" | "compat">,
>(
  model: T,
  endpoint: string,
  modelId: string,
  capabilities: ReturnType<typeof resolveFoundryModelCapabilities>,
  preserveExplicitReasoningEffort: boolean,
) {
  const explicitSupportsReasoningEffort =
    typeof model.compat?.supportsReasoningEffort === "boolean"
      ? model.compat.supportsReasoningEffort
      : undefined;
  const explicitMaxTokensField =
    typeof model.compat?.maxTokensField === "string"
      ? model.compat.maxTokensField
      : preserveExplicitReasoningEffort
        ? "max_completion_tokens"
        : undefined;
  return {
    ...model,
    name: capabilities.modelName,
    api: capabilities.api,
    baseUrl: buildFoundryProviderBaseUrl(
      endpoint,
      modelId,
      capabilities.modelName,
      capabilities.api,
    ),
    reasoning: capabilities.reasoning || model.reasoning,
    thinkingLevelMap: capabilities.thinkingLevelMap ?? model.thinkingLevelMap,
    params: { ...model.params, canonicalModelId: capabilities.modelName },
    input: capabilities.input,
    ...(capabilities.compat
      ? {
          compat: {
            ...model.compat,
            ...capabilities.compat,
            ...(explicitSupportsReasoningEffort !== undefined
              ? { supportsReasoningEffort: explicitSupportsReasoningEffort }
              : preserveExplicitReasoningEffort
                ? { supportsReasoningEffort: true }
                : undefined),
            ...(explicitMaxTokensField ? { maxTokensField: explicitMaxTokensField } : {}),
          },
        }
      : {}),
  };
}

export function buildMicrosoftFoundryProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Microsoft Foundry",
    docsPath: "/providers/models",
    envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    auth: [entraIdAuthMethod, apiKeyAuthMethod],
    onModelSelected: async (ctx) => {
      const providers = ctx.config.models?.providers;
      const providerConfig = providers?.[PROVIDER_ID];
      if (
        !providers ||
        !providerConfig ||
        !providerConfig.baseUrl?.trim() ||
        !Array.isArray(providerConfig.models) ||
        !ctx.model.startsWith(`${PROVIDER_ID}/`)
      ) {
        return;
      }
      const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
      const configuredModels = providerConfig.models;
      const existingModel = configuredModels.find((model) => model.id === selectedModelId);
      const existingModelApi = isFoundryProviderApi(existingModel?.api)
        ? existingModel.api
        : undefined;
      const providerApiForExistingModel =
        existingModel && isFoundryProviderApi(providerConfig.api) ? providerConfig.api : undefined;
      const selectedModelCapabilities = resolveFoundryModelCapabilities(
        selectedModelId,
        existingModel?.name,
        existingModelApi ?? providerApiForExistingModel,
        existingModel?.input,
      );
      const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl);
      const selectedProviderEndpoint =
        extractFoundryEndpoint(existingModel?.baseUrl) ?? providerEndpoint;
      const nextModels = configuredModels.map((model) => {
        if (model.id !== selectedModelId) {
          return model;
        }
        const selectedModelEndpoint = extractFoundryEndpoint(model.baseUrl) ?? providerEndpoint;
        return normalizeFoundryModel(
          model,
          selectedModelEndpoint,
          selectedModelId,
          selectedModelCapabilities,
          !selectedModelCapabilities.reasoning &&
            model.reasoning &&
            model.compat?.supportsReasoningEffort !== false,
        );
      });
      if (!nextModels.some((model) => model.id === selectedModelId)) {
        nextModels.push(
          buildFoundryModelConfig(providerEndpoint, selectedModelId, selectedModelCapabilities),
        );
      }
      const nextProviderConfig: ModelProviderConfig = {
        ...providerConfig,
        baseUrl: buildFoundryProviderBaseUrl(
          selectedProviderEndpoint,
          selectedModelId,
          selectedModelCapabilities.modelName,
          selectedModelCapabilities.api,
        ),
        api: selectedModelCapabilities.api,
        models: nextModels,
      };
      const targetProfileId = resolveFoundryTargetProfileId(ctx.config);
      if (targetProfileId) {
        ctx.config.auth = applyAuthProfileConfig(ctx.config, {
          profileId: targetProfileId,
          provider: PROVIDER_ID,
          mode: "api_key",
        }).auth;
      }
      providers[PROVIDER_ID] = nextProviderConfig;
    },
    resolveThinkingProfile: ({ modelId, params }) => {
      const modelName =
        typeof params?.canonicalModelId === "string" ? params.canonicalModelId : undefined;
      const capabilities = resolveFoundryModelCapabilities(modelId, modelName);
      if (!capabilities.reasoning || capabilities.api !== "anthropic-messages") {
        return undefined;
      }
      return resolveClaudeThinkingProfile(capabilities.modelName, undefined, {
        includeNativeMax: supportsClaudeNativeMaxEffort({ id: capabilities.modelName }),
      });
    },
    normalizeResolvedModel: ({ modelId, model }: ProviderNormalizeResolvedModelContext) => {
      const endpoint = extractFoundryEndpoint(model.baseUrl ?? "");
      if (!endpoint) {
        return model;
      }
      const capabilities = resolveFoundryModelCapabilities(
        modelId,
        model.name,
        isFoundryProviderApi(model.api) ? model.api : undefined,
        model.input,
      );
      return normalizeFoundryModel(
        model,
        endpoint,
        modelId,
        capabilities,
        !capabilities.reasoning && model.reasoning,
      );
    },
    wrapStreamFn: wrapMicrosoftFoundryStreamFn,
    prepareRuntimeAuth: prepareFoundryRuntimeAuth,
  };
}
