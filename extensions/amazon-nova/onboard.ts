import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModels,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildAmazonNovaProvider, AMAZON_NOVA_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const AMAZON_NOVA_DEFAULT_MODEL_REF = `amazon-nova/${AMAZON_NOVA_DEFAULT_MODEL_ID}`;

export function applyAmazonNovaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[AMAZON_NOVA_DEFAULT_MODEL_REF] = {
    ...models[AMAZON_NOVA_DEFAULT_MODEL_REF],
    alias: models[AMAZON_NOVA_DEFAULT_MODEL_REF]?.alias ?? "Amazon Nova",
  };
  const defaultProvider = buildAmazonNovaProvider();
  const resolvedApi = defaultProvider.api ?? "openai-completions";
  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: models,
    providerId: "amazon-nova",
    api: resolvedApi,
    baseUrl: defaultProvider.baseUrl,
    defaultModels: defaultProvider.models ?? [],
    defaultModelId: AMAZON_NOVA_DEFAULT_MODEL_ID,
  });
}

export function applyAmazonNovaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyAmazonNovaProviderConfig(cfg),
    AMAZON_NOVA_DEFAULT_MODEL_REF,
  );
}
