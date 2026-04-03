import {
  createModelCatalogPresetAppliers,
  ensureModelAllowlistEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildGmicloudModelDefinition,
  GMICLOUD_BASE_URL,
  GMICLOUD_DEFAULT_MODEL_ID,
  GMICLOUD_MODEL_CATALOG,
} from "./models.js";

export const GMICLOUD_DEFAULT_MODEL_REF = `gmicloud/${GMICLOUD_DEFAULT_MODEL_ID}`;
export const GMICLOUD_SONNET_MODEL_REF = "gmicloud/anthropic/claude-sonnet-4.6";
export const GMICLOUD_GPT_MODEL_REFS = [
  "gmicloud/openai/gpt-5.4",
  "gmicloud/openai/gpt-5.4-pro",
  "gmicloud/openai/gpt-5.4-mini",
  "gmicloud/openai/gpt-5.4-nano",
] as const;
export const GMICLOUD_GEMINI_MODEL_REFS = [
  "gmicloud/google/gemini-3.1-pro-preview",
  "gmicloud/google/gemini-3.1-flash-lite-preview",
] as const;
const GMICLOUD_LEGACY_DEFAULT_MODEL_REF = "gmicloud/deepseek-ai/DeepSeek-V3-0324";
const GMICLOUD_ONBOARD_MODEL_REFS = [
  GMICLOUD_DEFAULT_MODEL_REF,
  GMICLOUD_SONNET_MODEL_REF,
  ...GMICLOUD_GPT_MODEL_REFS,
  ...GMICLOUD_GEMINI_MODEL_REFS,
] as const;

const gmicloudPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: GMICLOUD_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "gmicloud",
    api: "openai-completions",
    baseUrl: GMICLOUD_BASE_URL,
    catalogModels: GMICLOUD_MODEL_CATALOG.map(buildGmicloudModelDefinition),
    aliases: [{ modelRef: GMICLOUD_DEFAULT_MODEL_REF, alias: "GMI Cloud" }],
  }),
});

function applyGmicloudPostConfig(cfg: OpenClawConfig): OpenClawConfig {
  let next = cfg;
  for (const modelRef of GMICLOUD_ONBOARD_MODEL_REFS) {
    next = ensureModelAllowlistEntry({
      cfg: next,
      modelRef,
      defaultProvider: "gmicloud",
    });
  }
  const models = { ...next.agents?.defaults?.models };
  delete models[GMICLOUD_LEGACY_DEFAULT_MODEL_REF];
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        models,
      },
    },
  };
}

export function applyGmicloudProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyGmicloudPostConfig(gmicloudPresetAppliers.applyProviderConfig(cfg));
}

export function applyGmicloudConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyGmicloudPostConfig(gmicloudPresetAppliers.applyConfig(cfg));
}
