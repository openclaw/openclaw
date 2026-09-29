import {
  createDefaultModelsPresetAppliers,
  createDefaultModelsConnectionPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildXiaomiProvider,
  buildXiaomiTokenPlanProvider,
  resolveXiaomiTokenPlanBaseUrl,
  XIAOMI_DEFAULT_MODEL_ID,
  XIAOMI_PROVIDER_ID,
  XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_ID,
  XIAOMI_TOKEN_PLAN_PROVIDER_ID,
  type XiaomiTokenPlanRegion,
} from "./provider-catalog.js";

export const XIAOMI_DEFAULT_MODEL_REF = `${XIAOMI_PROVIDER_ID}/${XIAOMI_DEFAULT_MODEL_ID}`;
export const XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF = `${XIAOMI_TOKEN_PLAN_PROVIDER_ID}/${XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_ID}`;

const xiaomiPreset = {
  primaryModelRef: XIAOMI_DEFAULT_MODEL_REF,
  resolveParams: () => {
    const defaultProvider = buildXiaomiProvider();
    return {
      providerId: XIAOMI_PROVIDER_ID,
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModels: () => defaultProvider.models ?? [],
      defaultModelId: XIAOMI_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: XIAOMI_DEFAULT_MODEL_REF, alias: "Xiaomi" }],
    };
  },
} satisfies Parameters<typeof createDefaultModelsConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyXiaomiConfig, applyProviderConfig: applyXiaomiProviderConfig } =
  createDefaultModelsPresetAppliers(xiaomiPreset);
export const { applyConfig: applyXiaomiConnectionConfig } =
  createDefaultModelsConnectionPresetAppliers(xiaomiPreset);

const xiaomiTokenPlanPresetAppliers = createDefaultModelsPresetAppliers<[]>({
  primaryModelRef: XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => {
    const defaultProvider = buildXiaomiTokenPlanProvider();
    const defaultModel = defaultProvider.models.find(
      (model) => model.id === XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_ID,
    );
    return {
      providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModels: cfg.models?.mode === "replace" ? (defaultProvider.models ?? []) : [],
      defaultModelId: XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_ID,
      aliases: [
        {
          modelRef: XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
          alias: defaultModel?.name ?? "Xiaomi MiMo V2.6 Pro",
        },
      ],
    };
  },
});

export function applyXiaomiTokenPlanConfig(
  cfg: OpenClawConfig,
  region: XiaomiTokenPlanRegion,
): OpenClawConfig {
  const next = xiaomiTokenPlanPresetAppliers.applyConfig(cfg);
  const provider = next.models!.providers![XIAOMI_TOKEN_PLAN_PROVIDER_ID];
  return {
    ...next,
    models: {
      ...next.models,
      providers: {
        ...next.models?.providers,
        [XIAOMI_TOKEN_PLAN_PROVIDER_ID]: {
          ...provider,
          baseUrl: resolveXiaomiTokenPlanBaseUrl(region),
        },
      },
    },
  };
}
