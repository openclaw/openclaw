import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildStepFunPlanProvider,
  buildStepFunProvider,
  STEPFUN_ALL_MANAGED_MODEL_IDS,
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
} from "./provider-catalog.js";

export {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
};

function findProviderKey(
  providers: Record<string, unknown> | undefined,
  providerId: string,
): string | undefined {
  return Object.keys(providers ?? {}).find(
    (key) => key.trim().toLowerCase() === providerId.trim().toLowerCase(),
  );
}

function stripManagedStepFunModels(cfg: OpenClawConfig, providerId: string): OpenClawConfig {
  const providerKey = findProviderKey(cfg.models?.providers, providerId);
  if (!providerKey) {
    return cfg;
  }
  const provider = cfg.models?.providers?.[providerKey];
  if (!provider || !Array.isArray(provider.models)) {
    return cfg;
  }
  const filteredModels = provider.models.filter((model) => {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    return !STEPFUN_ALL_MANAGED_MODEL_IDS.has(id);
  });
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [providerKey]: {
          ...provider,
          models: filteredModels,
        },
      },
    },
  };
}

function applyManagedStepFunCatalogs(params: {
  cfg: OpenClawConfig;
  standardBaseUrl: string;
  planBaseUrl: string;
  primaryModelRef: string;
}): OpenClawConfig {
  let next = stripManagedStepFunModels(params.cfg, STEPFUN_PROVIDER_ID);
  next = stripManagedStepFunModels(next, STEPFUN_PLAN_PROVIDER_ID);

  const standardProvider = buildStepFunProvider(params.standardBaseUrl);
  next = applyProviderConfigWithModelCatalogPreset(next, {
    providerId: STEPFUN_PROVIDER_ID,
    api: standardProvider.api ?? "openai-completions",
    baseUrl: params.standardBaseUrl,
    catalogModels: standardProvider.models ?? [],
    aliases: [
      ...(standardProvider.models ?? []).map((model) => `${STEPFUN_PROVIDER_ID}/${model.id}`),
      { modelRef: STEPFUN_DEFAULT_MODEL_REF, alias: "StepFun" },
    ],
  });

  const planProvider = buildStepFunPlanProvider(params.planBaseUrl);
  next = applyProviderConfigWithModelCatalogPreset(next, {
    providerId: STEPFUN_PLAN_PROVIDER_ID,
    api: planProvider.api ?? "openai-completions",
    baseUrl: params.planBaseUrl,
    catalogModels: planProvider.models ?? [],
    aliases: [
      ...(planProvider.models ?? []).map((model) => `${STEPFUN_PLAN_PROVIDER_ID}/${model.id}`),
      { modelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF, alias: "StepFun Plan" },
    ],
  });

  return applyAgentDefaultModelPrimary(next, params.primaryModelRef);
}

export function applyStepFunStandardConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyManagedStepFunCatalogs({
    cfg,
    standardBaseUrl: STEPFUN_STANDARD_CN_BASE_URL,
    planBaseUrl: STEPFUN_PLAN_CN_BASE_URL,
    primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
  });
}

export function applyStepFunStandardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyManagedStepFunCatalogs({
    cfg,
    standardBaseUrl: STEPFUN_STANDARD_INTL_BASE_URL,
    planBaseUrl: STEPFUN_PLAN_INTL_BASE_URL,
    primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
  });
}

export function applyStepFunPlanConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyManagedStepFunCatalogs({
    cfg,
    standardBaseUrl: STEPFUN_STANDARD_CN_BASE_URL,
    planBaseUrl: STEPFUN_PLAN_CN_BASE_URL,
    primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
  });
}

export function applyStepFunPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyManagedStepFunCatalogs({
    cfg,
    standardBaseUrl: STEPFUN_STANDARD_INTL_BASE_URL,
    planBaseUrl: STEPFUN_PLAN_INTL_BASE_URL,
    primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
  });
}
