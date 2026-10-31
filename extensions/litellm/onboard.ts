import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createDefaultModelsPresetAppliers,
  applyProviderConfigWithDefaultModelPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
export const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;
const LITELLM_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const LITELLM_DEFAULT_MAX_TOKENS = 128_000;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildLitellmModelDefinition(): ModelDefinitionConfig {
  return {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
}

export async function applyLitellmModelConfig(
  cfg: OpenClawConfig,
  modelId: string,
): Promise<OpenClawConfig> {
  const {
    SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    SELF_HOSTED_DEFAULT_COST,
    SELF_HOSTED_DEFAULT_MAX_TOKENS,
  } = await import("openclaw/plugin-sdk/provider-setup");
  const modelRef = `litellm/${modelId}`;
  return applyProviderConfigWithDefaultModelPreset(cfg, {
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: cfg.models?.providers?.litellm?.baseUrl ?? LITELLM_BASE_URL,
    defaultModel:
      modelId === LITELLM_DEFAULT_MODEL_ID
        ? buildLitellmModelDefinition()
        : {
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: SELF_HOSTED_DEFAULT_COST,
            contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
            maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
          },
    aliases: [{ modelRef, alias: "LiteLLM" }],
    primaryModelRef: modelRef,
  });
}

export const { applyConfig: applyLitellmConfig, applyProviderConfig: applyLitellmProviderConfig } =
  createDefaultModelsPresetAppliers<[]>({
    primaryModelRef: LITELLM_DEFAULT_MODEL_REF,
    resolveParams: (cfg: OpenClawConfig) => {
      const resolvedBaseUrl =
        resolveMergedModelProviderConfig(cfg, "litellm")?.baseUrl?.trim() ?? "";

      return {
        providerId: "litellm",
        api: "openai-completions" as const,
        baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
        // Replace mode disables discovery, so it still needs the configured default.
        defaultModels:
          resolvedBaseUrl && cfg.models?.mode !== "replace" ? [] : [buildLitellmModelDefinition()],
        defaultModelId: LITELLM_DEFAULT_MODEL_ID,
        aliases: [{ modelRef: LITELLM_DEFAULT_MODEL_REF, alias: "LiteLLM" }],
      };
    },
  });
