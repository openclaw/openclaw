import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
// Kimi Coding setup module handles plugin onboarding behavior.
import {
  createDefaultModelsPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildKimiCodingProvider,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
export const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;

function resolveKimiCodingDefaultModel() {
  return buildKimiCodingProvider().models.find(
    (model) => model.id === KIMI_CODING_DEFAULT_MODEL_ID,
  );
}

const kimiCodingPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: KIMI_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const defaultModel = resolveKimiCodingDefaultModel();
    if (!defaultModel) {
      return null;
    }
    return {
      providerId: "kimi",
      api: "anthropic-messages",
      baseUrl: KIMI_CODING_BASE_URL,
      defaultModels: cfg.models?.mode === "replace" ? [defaultModel] : [],
      defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: KIMI_MODEL_REF, alias: "Kimi" }],
    };
  },
});

export function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kimiCodingPresetAppliers.applyConfig(cfg);
}

export function applyKimiProviderConnectionConfig(cfg: OpenClawConfig): OpenClawConfig {
  const existing =
    cfg.models?.providers?.kimi ??
    Object.entries(cfg.models?.providers ?? {}).find(
      ([id]) => normalizeProviderId(id) === "kimi",
    )?.[1];
  const next = kimiCodingPresetAppliers.applyProviderConfig(cfg);
  const connection = next.models?.providers?.kimi;
  if (existing && connection) {
    connection.baseUrl = existing.baseUrl;
    connection.api = existing.api ?? connection.api;
  }
  return next;
}
