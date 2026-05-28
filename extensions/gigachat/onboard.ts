import {
  createDefaultModelsPresetAppliers,
  type ModelApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  GIGACHAT_DEFAULT_MODEL_ID,
  GIGACHAT_PROVIDER_ID,
  resolveGigachatChatBaseUrl,
} from "./config.js";
import { buildGigachatProvider } from "./provider-catalog.js";

export const GIGACHAT_DEFAULT_MODEL_REF = `${GIGACHAT_PROVIDER_ID}/${GIGACHAT_DEFAULT_MODEL_ID}`;

function resolveGigachatPreset(cfg: OpenClawConfig): {
  api: ModelApi;
  baseUrl: string;
  defaultModels: NonNullable<ReturnType<typeof buildGigachatProvider>["models"]>;
} {
  const defaultProvider = buildGigachatProvider(cfg);
  const existingProvider = cfg.models?.providers?.[GIGACHAT_PROVIDER_ID] as
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
    baseUrl: existingBaseUrl || resolveGigachatChatBaseUrl(cfg),
    defaultModels: defaultProvider.models ?? [],
  };
}

const gigachatPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: GIGACHAT_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const preset = resolveGigachatPreset(cfg);
    return {
      providerId: GIGACHAT_PROVIDER_ID,
      api: preset.api,
      baseUrl: preset.baseUrl,
      defaultModels: preset.defaultModels,
      defaultModelId: GIGACHAT_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: GIGACHAT_DEFAULT_MODEL_REF, alias: "GigaChat" }],
    };
  },
});

export function applyGigachatProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return gigachatPresetAppliers.applyProviderConfig(cfg);
}

export function applyGigachatConfig(cfg: OpenClawConfig): OpenClawConfig {
  return gigachatPresetAppliers.applyConfig(cfg);
}
