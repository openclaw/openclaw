import {
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
  return gmicloudPresetAppliers.applyProviderConfig(cfg);
}

export function applyGmicloudConfig(cfg: OpenClawConfig): OpenClawConfig {
  return gmicloudPresetAppliers.applyConfig(cfg);
}
