import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildYandexModelDefinition, YANDEX_BASE_URL, YANDEX_MODEL_CATALOG } from "./api.js";

export const YANDEX_DEFAULT_MODEL_REF = "yandex/yandexgpt/latest";

const yandexPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: YANDEX_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "yandex",
    api: "openai-completions",
    baseUrl: YANDEX_BASE_URL,
    catalogModels: YANDEX_MODEL_CATALOG.map(buildYandexModelDefinition),
    aliases: [{ modelRef: YANDEX_DEFAULT_MODEL_REF, alias: "YandexGPT" }],
  }),
});

export function applyYandexProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return yandexPresetAppliers.applyProviderConfig(cfg);
}

export function applyYandexConfig(cfg: OpenClawConfig): OpenClawConfig {
  return yandexPresetAppliers.applyConfig(cfg);
}
