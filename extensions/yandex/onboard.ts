import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildYandexModelDefinition, YANDEX_BASE_URL, YANDEX_MODEL_CATALOG, YANDEX_MODEL_NAMES } from "./models.js";

export const YANDEX_DEFAULT_MODEL_REF = `yandex/${YANDEX_MODEL_NAMES.PRO_5_1}`;

const yandexPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: YANDEX_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const folderId = cfg.models?.providers?.["yandex"]?.headers?.["OpenAI-Project"] as
      | string
      | undefined;
    return {
      providerId: "yandex",
      api: "openai-completions",
      baseUrl: YANDEX_BASE_URL,
      ...(folderId ? { headers: { "OpenAI-Project": folderId } } : {}),
      catalogModels: YANDEX_MODEL_CATALOG.map(buildYandexModelDefinition),
      aliases: [{ modelRef: YANDEX_DEFAULT_MODEL_REF, alias: "YandexGPT" }],
    };
  },
});

export function applyYandexProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return yandexPresetAppliers.applyProviderConfig(cfg);
}

export function applyYandexConfig(cfg: OpenClawConfig): OpenClawConfig {
  return yandexPresetAppliers.applyConfig(cfg);
}
