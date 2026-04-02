import {
  applyAgentDefaultModelPrimary,
  createDefaultModelsPresetAppliers,
  type ModelApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildGmicloudProvider,
  GMICLOUD_BASE_URL,
  GMICLOUD_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

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

function upsertModelAlias(
  models: Record<string, { alias?: string }>,
  modelRef: string,
  alias: string,
): void {
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? alias,
  };
}

function resolveGmicloudPreset(cfg: OpenClawConfig): {
  api: ModelApi;
  baseUrl: string;
  defaultModels: NonNullable<ReturnType<typeof buildGmicloudProvider>["models"]>;
} {
  const defaultProvider = buildGmicloudProvider();
  const existingProvider = cfg.models?.providers?.gmicloud as
    | {
        baseUrl?: unknown;
        api?: unknown;
      }
    | undefined;
  const existingBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const api =
    typeof existingProvider?.api === "string"
      ? (existingProvider.api as ModelApi)
      : "openai-completions";

  return {
    api,
    baseUrl: existingBaseUrl || GMICLOUD_BASE_URL,
    defaultModels: defaultProvider.models ?? [],
  };
}

const gmicloudPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: GMICLOUD_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const preset = resolveGmicloudPreset(cfg);
    return {
      providerId: "gmicloud",
      api: preset.api,
      baseUrl: preset.baseUrl,
      defaultModels: preset.defaultModels,
      defaultModelId: GMICLOUD_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: GMICLOUD_DEFAULT_MODEL_REF, alias: "GMI Cloud" }],
    };
  },
});

export function applyGmicloudProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = gmicloudPresetAppliers.applyProviderConfig(cfg);
  const models = { ...next.agents?.defaults?.models } as Record<string, { alias?: string }>;
  delete models[GMICLOUD_LEGACY_DEFAULT_MODEL_REF];
  for (const modelRef of GMICLOUD_ONBOARD_MODEL_REFS) {
    models[modelRef] = { ...models[modelRef] };
  }
  upsertModelAlias(models, GMICLOUD_DEFAULT_MODEL_REF, "GMI Cloud");
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

export function applyGmicloudConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyGmicloudProviderConfig(cfg),
    GMICLOUD_DEFAULT_MODEL_REF,
  );
}
